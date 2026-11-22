import assert from "node:assert/strict";
import test from "node:test";
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import ExcelJS from "exceljs";
import { JWT } from "google-auth-library";
import { POST } from "../app/api/agent/route.ts";
import { chatToolLabels, markChatInterrupted, prepareAgentMessages } from "../lib/chat.ts";
import { createSession, SESSION_COOKIE } from "../lib/server/session.ts";
import { chatResponse } from "../lib/server/agent-chat.ts";
import { generatePicture, validateImagePrompt } from "../lib/server/image-generation.ts";
import { imageFailureMessages } from "../lib/image-errors.ts";
import { XLSX_TYPE } from "../lib/documents.ts";

// Dane i odpowiedzi testowe; bez .env i bez prawdziwych wywołań modeli.
process.env.NODE_ENV = "test";
process.env.CHAT_PASSWORD = "test-only-password";
process.env.SESSION_SECRET = "test-only-session-secret-with-at-least-32-characters";
process.env.OPENROUTER_API_KEY = "test-only-key";
process.env.OPENROUTER_MODEL = "test/chat-model";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const imageUrl = `data:image/png;base64,${png}`;
const headers = () => ({ "Content-Type": "application/json", Origin: "http://localhost", Cookie: `${SESSION_COOKIE}=${createSession()}` });
const request = (body, extraHeaders = {}) => new Request("http://localhost/api/agent", {
  method: "POST", headers: { ...headers(), ...extraHeaders }, body: JSON.stringify(body),
});
function streamReply({ name, input = {}, id = "call-1", sources = [], prefixText = "", calls, text = "Gotowe.", finishReason } = {}) {
  const toolCalls = calls ?? (name ? [{ name, input, id }] : []);
  const delta = toolCalls.length ? {
    tool_calls: toolCalls.map(({ name, input, id }, index) => ({
      index, id, type: "function", function: { name, arguments: JSON.stringify(input) },
    })), ...(prefixText ? { content: prefixText } : {}),
  } : { content: text };
  const data = (delta, finish_reason) => `data: ${JSON.stringify({
    id: "reply", model: "test/actual-chat-model", created: 0,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`;
  const annotations = sources.length ? data({ annotations: sources.map((url) => ({
    type: "url_citation", url_citation: { url, title: "Źródło testowe" },
  })) }, null) : "";
  return new Response(annotations + data(delta, null) + data({}, finishReason ?? (toolCalls.length ? "tool_calls" : "stop")) + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}
function client(browserRequests = [], sessionHeaders = headers(), onFinish, handler = POST) {
  return new Chat({ onFinish, transport: new DefaultChatTransport({
    api: "/api/agent",
    prepareSendMessagesRequest: ({ messages }) => ({ body: { mode: "chat", messages: prepareAgentMessages(messages) } }),
    fetch: async (_url, options) => {
      browserRequests.push(JSON.parse(options.body));
      return handler(new Request("http://localhost/api/agent", { ...options, headers: sessionHeaders }));
    },
  }) });
}

test("narzędzia codzienne działają przez czat, a Wikipedia i rejestr UE dodają źródła i etykiety", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-21T12:00:00Z") });
  const calls = [
    ["pogoda", { miasto: "Warszawa", data: "2026-11-21", kraj: "pl" }],
    ["waluty", { waluta: "eur", kwota: 10 }],
    ["swieta", { kraj: "PL", rok: 2026 }],
    ["wikipedia", { haslo: "Warszawa" }],
    ["oswiadczeniaZdrowotneUE", { skladnik: "witamina C", status: "dopuszczone" }],
    ["kalkulator", { operacja: "pomnoz", a: 17, b: 23 }],
    ["czas", { strefa: "Asia/Tokyo" }],
    ["notatki", { operacja: "zapisz", tresc: "Sprawdzić stany magazynowe" }],
    ["diagnostyka", {}],
  ];
  const data = new Map([
    ["geocoding-api.open-meteo.com", { results: [{ name: "Warszawa", latitude: 52.23, longitude: 21.01, country_code: "PL" }] }],
    ["api.open-meteo.com", { timezone: "Europe/Warsaw", daily: {
      time: ["2026-11-21"], weather_code: [3], temperature_2m_min: [1], temperature_2m_max: [4], precipitation_probability_max: [40],
    } }],
    ["api.nbp.pl", { code: "EUR", rates: [{ mid: 4.25, effectiveDate: "2026-11-20" }] }],
    ["nagerholidays.com", [
      { date: "2026-01-01", name: "New Year's Day", nationalHoliday: true, subdivisionCodes: null, holidayTypes: ["Public"] },
      { date: "2026-08-15", name: "Regional holiday", nationalHoliday: false, subdivisionCodes: ["PL-01"], holidayTypes: ["Public"] },
      { date: "2026-12-31", name: "Bank holiday", nationalHoliday: true, subdivisionCodes: null, holidayTypes: ["Bank"] },
    ]],
    ["pl.wikipedia.org", { query: { pages: [{ ns: 0, pageid: 6605, title: "Warszawa", extract: "Stolica Polski." }] } }],
  ]);
  const modelRequests = [];
  const publicRequests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const address = new URL(url);
    if (address.hostname !== "openrouter.ai") {
      publicRequests.push(address);
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers.Cookie, undefined);
      if (address.hostname === "api.datalake.sante.service.ec.europa.eu") {
        return new Response(JSON.stringify({
          policy_item_code: "POL-HC-6510", nutrient_subst_food_no_html: "Vitamin C",
          claim_status: "Authorised", claim: "<p>Vitamin C contributes to the normal function of the immune system.</p>",
          condition_of_use: "The food must be at least a source of vitamin C.", restrictions_of_use: null,
          reasons_of_non_authorisation: null, proprietary_data: "No", restriction_expiry_date: null,
        }));
      }
      assert.ok(data.has(address.hostname));
      assert.equal(options.headers.Accept, "application/json");
      return Response.json(data.get(address.hostname));
    }
    modelRequests.push(JSON.parse(options.body));
    if (modelRequests.length > 1) return streamReply();
    const event = (delta, finish_reason) => `data: ${JSON.stringify({
      id: "tool-suite", model: "test/actual-chat-model", created: 0,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    const toolCalls = calls.map(([name, input], index) => ({
      index, id: `suite-${index}`, type: "function", function: { name, arguments: JSON.stringify(input) },
    }));
    return new Response(event({ tool_calls: toolCalls }, null) + event({}, "tool_calls") + "data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  });

  const chat = client();
  await chat.sendMessage({ text: "Sprawdź prognozę, kurs, święta i Wikipedię. Oblicz 17 × 23, podaj czas w Tokio, zapisz notatkę i wykonaj diagnostykę." });
  assert.equal(chat.status, "ready");
  assert.equal(modelRequests.length, 2);
  for (const expected of [
    ["geocoding-api.open-meteo.com", "/v1/search", "countryCode", "PL"],
    ["api.open-meteo.com", "/v1/forecast", "end_date", "2026-11-21"],
    ["api.nbp.pl", "/api/exchangerates/rates/a/eur/2026-11-07/2026-11-21/"],
    ["nagerholidays.com", "/api/v4/Holidays/PL/2026"],
    ["pl.wikipedia.org", "/w/api.php", "titles", "Warszawa"],
    ["api.datalake.sante.service.ec.europa.eu", "/health-claims/download-eu-register", "api-version", "v2.0"],
  ]) {
    const [host, path, key, value] = expected;
    assert.ok(publicRequests.some((url) => url.hostname === host && url.pathname === path && (!key || url.searchParams.get(key) === value)));
  }
  const answer = chat.messages.at(-1);
  assert.deepEqual(answer.metadata.usedTools, calls.map(([name]) => name));
  assert.deepEqual(answer.metadata.toolSteps, [{ step: 1, tools: calls.map(([name]) => name) }]);
  assert.equal(answer.metadata.statistics.steps, 2);
  assert.equal(answer.metadata.statistics.toolCalls, calls.length);
  assert.ok(answer.metadata.statistics.elapsedMs >= 0);
  const outputs = Object.fromEntries(answer.parts.filter((part) => part.state === "output-available")
    .map((part) => [part.type.slice(5), part.output]));
  assert.deepEqual(Object.keys(outputs).sort(), calls.map(([name]) => name).sort());
  for (const output of Object.values(outputs)) assert.ok(Number.isFinite(Date.parse(output.pobrano)));
  assert.equal(outputs.pogoda.warunki, "pochmurno");
  assert.equal(outputs.waluty.wynik, 42.5);
  assert.equal(outputs.swieta.dniWolne.length, 2);
  assert.deepEqual(outputs.swieta.dniWolne[1].regiony, ["PL-01"]);
  assert.equal(outputs.wikipedia.streszczenie, "Stolica Polski.");
  assert.ok(answer.parts.some((part) => part.type === "source-url" && part.url === "https://pl.wikipedia.org/?curid=6605"));
  assert.equal(answer.metadata.retrievedAt, outputs.wikipedia.pobrano);
  const claim = outputs.oswiadczeniaZdrowotneUE.wyniki[0];
  assert.equal(claim.status, "dopuszczone");
  assert.equal(claim.warunkiUzycia, "The food must be at least a source of vitamin C.");
  assert.ok(answer.parts.some((part) => part.type === "source-url" && part.url.endsWith("/details/POL-HC-6510")));
  assert.equal(outputs.kalkulator.wynik, 391);
  assert.equal(outputs.czas.strefa, "Asia/Tokyo");
  assert.equal(outputs.notatki.zapisano, true);
  assert.equal(outputs.diagnostyka.model, "test/chat-model");
  assert.equal(outputs.diagnostyka.limitKrokow, 10);
  assert.deepEqual(outputs.diagnostyka.narzedzia.sort(), Object.keys(chatToolLabels).sort());
  assert.deepEqual(outputs.diagnostyka.zmienneUstawione, {
    CHAT_PASSWORD: true, SESSION_SECRET: true, OPENROUTER_API_KEY: true, OPENROUTER_MODEL: true,
  });
  const serialized = JSON.stringify(outputs.diagnostyka);
  for (const secret of [process.env.CHAT_PASSWORD, process.env.SESSION_SECRET, process.env.OPENROUTER_API_KEY]) {
    assert.ok(!serialized.includes(secret));
  }
  await chat.sendMessage({ text: "Dziękuję." });
  assert.equal(chat.status, "ready");
});

function samplePdf(text = "Oferta hurtowa: 65 PLN", content = `BT /F1 14 Tf 20 100 Td (${text}) Tj ET`) {
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return { type: "file", filename: "oferta.pdf", mediaType: "application/pdf", url: `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}` };
}

test("PDF przechodzi przez czat, a model dostaje tekst z numerem strony bez bajtów pliku", async () => {
  const file = samplePdf();
  const modelRequests = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(options.body);
    assert.ok(!JSON.stringify(body).includes(file.url));
    modelRequests.push(body);
    return modelRequests.length === 1 ? streamReply({ name: "czytajPdf", input: {} }) : streamReply();
  };
  const chat = client();
  await chat.sendMessage({ text: "Jaka jest cena z załączonej oferty?", files: [file] });
  assert.equal(chat.status, "ready");
  assert.equal(modelRequests.length, 2);
  assert.deepEqual(chat.messages.at(-1).metadata.usedTools, ["czytajPdf"]);
  const tool = modelRequests[1].messages.find((message) => message.role === "tool");
  const result = JSON.parse(tool.content);
  assert.deepEqual(result.strony, [{ numer: 1, tekst: "Oferta hurtowa: 65 PLN", skrocona: false }]);
});

test("uszkodzony lub podszywający się za PDF załącznik daje bezpieczny komunikat", async () => {
  globalThis.fetch = async () => assert.fail("Nie wywołuj modelu przy błędnym nagłówku");
  const response = await POST(request({ mode: "chat", messages: [{
    id: "pdf", role: "user", parts: [{ ...samplePdf(), url: `data:application/pdf;base64,${png}` }],
  }] }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /poprawny PDF/);
});

test("czat odczytuje XLSX i zwraca edytowaną kopię tylko przeglądarce", async () => {
  const original = new ExcelJS.Workbook();
  const sheet = original.addWorksheet("Zakupy");
  sheet.getCell("A1").value = "Produkt";
  sheet.getCell("B2").value = 65;
  sheet.getCell("C2").value = { formula: "B2*2", result: 130 };
  const content = Buffer.from(await original.xlsx.writeBuffer()).toString("base64");
  const file = { type: "file", mediaType: XLSX_TYPE, filename: "zakupy.xlsx", url: `data:${XLSX_TYPE};base64,${content}` };
  const modelRequests = [];
  const browserRequests = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(options.body);
    assert.ok(!JSON.stringify(body).includes(file.url));
    assert.ok(!JSON.stringify(body).includes('"base64"'), "Model nie otrzymuje pliku kopii");
    modelRequests.push(body);
    switch (modelRequests.length) {
      case 1: return streamReply({ name: "arkusze", input: { zrodlo: "xlsx", operacja: "odczyt", karta: "Zakupy", zakres: "B2:C2" } });
      case 3: return streamReply({ name: "arkusze", input: { zrodlo: "xlsx", operacja: "edycja", karta: "Zakupy", zakres: "B2", wartosci: [[70]] } });
      default: return streamReply();
    }
  };
  const chat = client(browserRequests);
  await chat.sendMessage({ text: "Odczytaj B2:C2.", files: [file] });
  assert.equal(chat.status, "ready");
  const read = modelRequests[1].messages.find((message) => message.role === "tool");
  assert.deepEqual(JSON.parse(read.content).wiersze, [[65, { formula: "B2*2", wartosc: 130 }]]);
  assert.deepEqual(chat.messages.at(-1).metadata.usedTools, ["arkusze"]);
  await chat.sendMessage({ text: "Zmień B2 na 70." });
  const result = chat.messages.at(-1).parts.find((part) => part.type === "tool-arkusze");
  assert.equal(result.state, "output-available");
  assert.equal(result.output.typ, "xlsx");
  const copy = new ExcelJS.Workbook();
  await copy.xlsx.load(Buffer.from(result.output.base64, "base64"));
  assert.equal(copy.getWorksheet("Zakupy").getCell("B2").value, 70);
  assert.equal(copy.getWorksheet("Zakupy").getCell("C2").formula, "B2*2");
  assert.equal(sheet.getCell("B2").value, 65);
  await chat.sendMessage({ text: "Co dalej?" });
  assert.ok(!JSON.stringify(browserRequests.at(-1)).includes(result.output.base64));
});

test("Google Sheets czyta podany arkusz i zapisuje wyłącznie po potwierdzeniu w tej samej sesji", async () => {
  const id = "test-only-workbook";
  const session = headers();
  const originalAuth = JWT.prototype.getAccessToken;
  JWT.prototype.getAccessToken = async () => ({ token: "test-only-google-token" });
  process.env.GOOGLE_SHEETS_CLIENT_EMAIL = "test@example.invalid";
  process.env.GOOGLE_SHEETS_PRIVATE_KEY = "test-only";
  process.env.GOOGLE_SHEETS_ALLOWED_IDS = id;
  let value = 65;
  let writes = 0;
  const modelRequests = [];
  const nextTool = (operacja) => streamReply({ name: "arkusze", input: {
    zrodlo: "google", operacja, id, karta: "Zakupy", zakres: "B2",
    ...(operacja === "edycja" && { wartosci: [[70]] }),
  } });
  try {
    globalThis.fetch = async (input, options) => {
      if (String(input) === "https://openrouter.ai/api/v1/chat/completions") {
        const body = JSON.parse(options.body);
        assert.ok(!JSON.stringify(body).includes("test-only-google-token"));
        assert.ok(!JSON.stringify(body).includes("potwierdzenie"));
        modelRequests.push(body);
        return modelRequests.length === 1 ? nextTool("odczyt")
          : modelRequests.length === 3 || modelRequests.length === 5 ? nextTool("edycja") : streamReply();
      }
      const url = new URL(input);
      assert.equal(url.origin, "https://sheets.googleapis.com");
      assert.equal(options.headers.Authorization, "Bearer test-only-google-token");
      if (!url.pathname.includes("/values/")) {
        assert.equal(url.pathname, `/v4/spreadsheets/${id}`);
        return Response.json({ properties: { title: "Cennik" }, sheets: [{ properties: { title: "Zakupy" } }] });
      }
      assert.equal(decodeURIComponent(url.pathname), `/v4/spreadsheets/${id}/values/'Zakupy'!B2`);
      if (options.method === "PUT") {
        writes++;
        assert.equal(url.searchParams.get("valueInputOption"), "RAW");
        assert.deepEqual(JSON.parse(options.body), { majorDimension: "ROWS", values: [[70]] });
        value = 70;
        return Response.json({ updatedCells: 1 });
      }
      return Response.json({ values: [[value]] });
    };
    const chat = client([], session);
    await chat.sendMessage({ text: `Odczytaj B2 z karty Zakupy https://docs.google.com/spreadsheets/d/${id}/edit` });
    const toolRead = modelRequests[1].messages.find((message) => message.role === "tool");
    assert.deepEqual(JSON.parse(toolRead.content).wiersze, [[65]]);
    await chat.sendMessage({ text: "Zmień B2 w Zakupach na 70." });
    const preview = () => chat.messages.at(-1).parts.find((part) => part.type === "tool-arkusze").output;
    assert.equal(preview().typ, "google-propozycja");
    assert.deepEqual(preview().przed, [[65]]);
    assert.equal(writes, 0);
    const write = (confirmation, authHeaders = session) =>
      POST(request({ mode: "sheet-write", confirmation }, authHeaders));
    assert.equal((await write(preview().potwierdzenie, { Cookie: "" })).status, 401);
    assert.equal((await write(preview().potwierdzenie, headers())).status, 400);
    assert.equal((await write("x" + preview().potwierdzenie)).status, 400);
    value = 66;
    assert.equal((await write(preview().potwierdzenie)).status, 409);
    assert.equal(writes, 0);
    await chat.sendMessage({ text: "Przygotuj nowy podgląd." });
    assert.deepEqual(preview().przed, [[66]]);
    const response = await write(preview().potwierdzenie);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { updatedCells: 1 });
    assert.equal(value, 70);
    assert.equal((await write(preview().potwierdzenie)).status, 409);
    assert.equal(writes, 1);
  } finally {
    JWT.prototype.getAccessToken = originalAuth;
    delete process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    delete process.env.GOOGLE_SHEETS_PRIVATE_KEY;
    delete process.env.GOOGLE_SHEETS_ALLOWED_IDS;
  }
});

test("agent kontroluje sesję i tryb przed jakimkolwiek wywołaniem dostawcy", async () => {
  globalThis.fetch = async () => assert.fail("Nie wolno wywoływać dostawcy");
  for (const mode of ["chat", "analyze", "sheet-write"]) {
    for (const Cookie of ["", `${SESSION_COOKIE}=fake`, `${SESSION_COOKIE}=${createSession(0)}`]) {
      assert.equal((await POST(request({ mode }, { Cookie }))).status, 401);
    }
  }
  assert.equal((await POST(new Request("http://localhost/api/agent", { method: "POST", body: "{bad" }))).status, 401);
  for (const body of [null, [], {}, { mode: "image" }, { mode: 1 }]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  assert.equal((await POST(request({ mode: "chat" }, { Origin: "https://obca.example" }))).status, 403);
});

test("narzędzie obrazu przekazuje plik do UI i tylko krótki tekst do modelu", async () => {
  const modelRequests = [];
  const browserRequests = [];
  let imageCalls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(options.body);
    if (body.modalities) {
      imageCalls++;
      assert.equal(body.model, "google/gemini-nano-banana-2.1");
      assert.deepEqual(body.messages, [{ role: "user", content: "Kot obok opakowania" }]);
      return Response.json({ model: "test/actual-image-model", choices: [{ message: {
        images: [{ image_url: { url: imageUrl } }],
      } }] });
    }
    modelRequests.push(body);
    assert.ok(!JSON.stringify(body.messages).includes(png), "Żaden krok nie może zawierać pliku wygenerowanego obrazu");
    return modelRequests.length === 1
      ? streamReply({ name: "generujObraz", input: { prompt: "Kot obok opakowania" } }) : streamReply();
  };
  const chat = client(browserRequests);
  await chat.sendMessage({ text: "Wygeneruj obraz: Kot obok opakowania" });
  assert.equal(chat.status, "ready");
  assert.equal(imageCalls, 1);
  assert.equal(modelRequests.length, 2);
  const result = modelRequests[1].messages.find((message) => message.role === "tool");
  assert.equal(result.content, "obraz wygenerowany");
  const imagePart = chat.messages.at(-1).parts.find((part) => part.type === "tool-generujObraz");
  assert.equal(imagePart.state, "output-available");
  assert.equal(imagePart.output.url, imageUrl);
  assert.equal(imagePart.output.modelId, "test/actual-image-model");
  assert.deepEqual(chat.messages.at(-1).metadata.usedTools, ["generujObraz"]);
  assert.ok(modelRequests[0].tools.some((tool) => tool.function?.name === "aktualnyCzas"));
  assert.ok(modelRequests[0].tools.some((tool) => tool.type === "openrouter:web_search"));

  await chat.sendMessage({ text: "Dziękuję, co dalej?" });
  assert.equal(chat.status, "ready");
  assert.equal(modelRequests.length, 3);
  assert.equal(imageCalls, 1);
  assert.ok(!JSON.stringify(browserRequests[1]).includes(png), "Przeglądarka nie odsyła pliku w historii");
  assert.match(JSON.stringify(modelRequests[2].messages), /obraz wygenerowany/);
  assert.equal(imagePart.output.url, imageUrl, "Plik pozostaje w stanie przeglądarki");
});

test("błąd generowania pozostaje błędem narzędzia, bez danych dostawcy i ponawiania obrazu", async () => {
  let chatCalls = 0;
  let imageCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.modalities) {
      imageCalls++;
      return Response.json({ error: { message: "SECRET-UPSTREAM-DETAIL" } }, { status: 503 });
    }
    chatCalls++;
    if (chatCalls === 1) return streamReply({ name: "generujObraz", input: { prompt: "Kot" } });
    assert.ok(!JSON.stringify(body).includes("SECRET-UPSTREAM-DETAIL"));
    return streamReply();
  };
  const chat = client();
  await chat.sendMessage({ text: "Wygeneruj kota" });
  assert.equal(chat.status, "ready");
  const part = chat.messages.at(-1).parts.find((part) => part.type === "tool-generujObraz");
  assert.equal(part.state, "output-error");
  assert.equal(part.errorText, imageFailureMessages.unavailable);
  assert.equal(imageCalls, 1);
});

test("dziesiąty krok nie wykonuje narzędzia i pokazuje zebrane dane, gdy model nie podsumuje wyników", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    if (calls === 10) {
      const body = JSON.parse(options.body);
      assert.equal(body.tool_choice, "none");
      assert.match(JSON.stringify(body.messages), /To ostatni krok\. Podsumuj/);
    }
    return streamReply({ name: "kalkulator", input: { operacja: "pomnoz", a: 17, b: 23 }, id: `calc-${calls}` });
  };
  const chat = client();
  await chat.sendMessage({ text: "Pomnóż 17 przez 23." });
  assert.equal(chat.status, "ready");
  assert.equal(calls, 10);
  const answer = chat.messages.at(-1);
  assert.deepEqual(answer.metadata.usedTools, Array(9).fill("kalkulator"));
  assert.equal(answer.parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
    "Zatrzymałem się po 10 krokach\nNie udało się uzyskać odpowiedzi modelu.\n\nZebrane informacje:\n• Wynik obliczenia: 391.");
});

test("dziesięciokrokowy plan obliczeń używa tylko narzędzia wskazanego na dany krok", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-22T12:00:00Z") });
  const operations = [
    { operacja: "dodaj", a: 2040, b: 180 },
    { operacja: "podziel", a: 2220, b: 120 },
    { operacja: "dodaj", a: 18.5, b: 1.2 },
    { operacja: "odejmij", a: 39, b: 19.7 },
    { operacja: "pomnoz", a: 19.3, b: 80 },
    { operacja: "odejmij", a: 1544, b: 320 },
    { operacja: "podziel", a: 1224, b: 4 },
    { operacja: "odejmij", a: 306, b: 250 },
  ];
  const steps = ["1. **Waluty:** przelicz 480 EUR.", ...operations.map(({ operacja }, index) =>
    `${index + 2}. **Kalkulator:** wykonaj działanie ${operacja} na wyniku poprzedniego kroku.`),
  "10. **Podsumowanie:** podaj dzienny zysk i różnicę do celu."];
  const previousResults = ["480 EUR = 2040 PLN", "2220", "18.5", "19.7", "19.3", "1544", "1224", "306", "56"];
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (new URL(url).hostname === "api.nbp.pl") {
      return Response.json({ code: "EUR", rates: [{ mid: 4.25, effectiveDate: "2026-11-20" }] });
    }
    const body = JSON.parse(options.body);
    const step = ++modelCalls;
    assert.ok(!body.tools?.some(({ type }) => type === "openrouter:web_search"));
    if (body.messages.some(({ role, tool_calls }) => role === "tool" || tool_calls?.length)) {
      return Response.json({ error: { message: "Provider rejected previous tool-call history" } }, { status: 400 });
    }
    const context = JSON.stringify(body.messages.at(-1).content);
    assert.doesNotMatch(context, /\*\*Kalkulator:/);
    if (step > 1) {
      for (const [index, value] of previousResults.slice(0, step - 1).entries()) {
        assert.ok(context.includes(`${index + 1}. ${index ? "Wynik obliczenia: " : ""}${value}`));
      }
    }
    if (step === 10) {
      assert.equal(body.tool_choice, "none");
      assert.match(context, /Podsumuj ustalenia: podaj dzienny zysk/);
      return streamReply({ text: "306 zł dziennie, czyli 56 zł powyżej celu." });
    }
    const name = step === 1 ? "waluty" : "kalkulator";
    assert.ok(context.includes(`Wykonaj tylko bieżącą czynność narzędziem ${name}:`));
    assert.deepEqual(body.tools.map((tool) => tool.function.name), [name]);
    assert.equal(body.tool_choice.function.name, name);
    const input = step === 1 ? { waluta: "EUR", kwota: 480 } : operations[step - 2];
    return streamReply({ name, input, id: `profit-${step}` });
  });
  const chat = client();
  await chat.sendMessage({ text: steps.join("\n") });
  const answer = chat.messages.at(-1);
  assert.equal(chat.status, "ready");
  assert.equal(modelCalls, 10);
  assert.equal(answer.metadata.statistics.toolCalls, 9);
  assert.match(answer.parts.filter(({ type }) => type === "text").map(({ text }) => text).join(""), /306 zł dziennie, czyli 56 zł powyżej celu/);
});

test("etykiety zachowują kolejność i powtórzenia narzędzi, wiele źródeł nie dubluje wyszukiwania", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.modalities) return Response.json({ model: "test/image", choices: [{ message: {
      images: [{ image_url: { url: imageUrl } }],
    } }] });
    calls++;
    if (calls === 1) {
      assert.match(JSON.stringify(body.messages[0]), /Przy zadaniu złożonym najpierw zbierz informacje, potem twórz/);
      return streamReply({ name: "aktualnyCzas", id: "clock-first" });
    }
    if (calls === 2) return streamReply({ name: "aktualnyCzas", id: "clock-again", sources: [
      "https://example.com/a", "https://example.com/b",
    ] });
    if (calls === 3) return streamReply({ name: "generujObraz", input: { prompt: "Ilustracja" } });
    return streamReply();
  };
  const chat = client();
  await chat.sendMessage({ text: "Zbierz informacje, a potem stwórz ilustrację." });
  assert.equal(chat.status, "ready");
  assert.deepEqual(chat.messages.at(-1).metadata.usedTools, ["aktualnyCzas", "web_search", "aktualnyCzas", "generujObraz"]);
  assert.deepEqual(chat.messages.at(-1).metadata.toolSteps, [
    { step: 1, tools: ["aktualnyCzas"] },
    { step: 2, tools: ["web_search", "aktualnyCzas"] },
    { step: 3, tools: ["generujObraz"] },
  ]);
  assert.equal(calls, 4);
});

test("naturalne zakończenie odpowiedzi w dziewiątym kroku nie jest oznaczane jako przerwanie", async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls < 9
    ? streamReply({ name: "aktualnyCzas", id: `clock-${calls}` }) : streamReply();
  const chat = client();
  await chat.sendMessage({ text: "Sprawdź daty i odpowiedz." });
  assert.equal(chat.status, "ready");
  assert.equal(calls, 9);
  const text = chat.messages.at(-1).parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.equal(text, "Gotowe.");
});

test("przy limicie zachowuje tekst z wcześniejszych kroków oraz ostatnie podsumowanie", async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls < 10
    ? streamReply({ name: "aktualnyCzas", id: `clock-${calls}`, prefixText: calls === 1 ? "Zbieram informacje. " : "" })
    : streamReply();
  const chat = client();
  await chat.sendMessage({ text: "Sprawdź daty." });
  const text = chat.messages.at(-1).parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.equal(text, "Zbieram informacje. Gotowe.\n\nZatrzymałem się po 10 krokach");
  assert.equal(calls, 10);
});

test("awaria modelu podczas podsumowania zachowuje ustalenia i komunikat o limicie", async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 10
    ? new Response("SZCZEGÓŁY AWARII DOSTAWCY", { status: 503 })
    : streamReply({ name: "kalkulator", id: `count-${calls}`, input: { operacja: "dodaj", a: 2, b: 3 } });
  const chat = client();
  await chat.sendMessage({ text: "Oblicz 2 + 3" });
  const text = chat.messages.at(-1).parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.equal(chat.status, "ready");
  assert.equal(calls, 10);
  assert.match(text, /Zatrzymałem się po 10 krokach\nNie udało się uzyskać odpowiedzi modelu/);
  assert.match(text, /Zebrane informacje:\n• Wynik obliczenia: 5\./);
  assert.doesNotMatch(text, /SZCZEGÓŁY AWARII DOSTAWCY/);
});

const boothRequest = "Jutro mam stoisko w Krakowie. Jeśli szansa opadów wynosi co najmniej 50%, przygotuj po 20 osłon przeciwdeszczowych na każdą z 4 zmian. W przeciwnym razie przygotuj po 5 na zmianę. Sprawdź prognozę i podaj łączną liczbę osłon.";

for (const { label, rain, limit, expectedTools } of [
  { label: "50% wybiera 80 osłon", rain: 50, expectedTools: ["aktualnyCzas", "pogoda", "kalkulator"] },
  { label: "49% wybiera 20 osłon", rain: 49, expectedTools: ["aktualnyCzas", "pogoda", "kalkulator"] },
  { label: "limit dwóch kroków zachowuje datę", rain: 50, limit: 2, expectedTools: ["aktualnyCzas"] },
  { label: "awaria prognozy kończy bez wyniku", rain: null, expectedTools: ["aktualnyCzas", "pogoda"] },
]) {
  test(`zapas na stoisko: ${label}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-29T23:30:00Z") });
    let modelCalls = 0;
    let forecastCalls = 0;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "geocoding-api.open-meteo.com") {
        assert.equal(address.searchParams.get("name"), "Kraków");
        return Response.json({ results: [{ name: "Kraków", country_code: "PL", latitude: 50.06, longitude: 19.94 }] });
      }
      if (address.hostname === "api.open-meteo.com") {
        forecastCalls++;
        assert.equal(address.searchParams.get("start_date"), "2026-12-01");
        assert.equal(address.searchParams.get("end_date"), "2026-12-01");
        if (rain === null) return new Response(null, { status: 503 });
        return Response.json({ timezone: "Europe/Warsaw", daily: {
          time: ["2026-12-01"], weather_code: [3], temperature_2m_min: [1], temperature_2m_max: [4], precipitation_probability_max: [rain],
        } });
      }
      assert.equal(address.hostname, "openrouter.ai");
      const body = JSON.parse(options.body);
      const priorResults = JSON.stringify(body.messages.filter(({ role }) => role === "tool"));
      if (++modelCalls === 1) {
        assert.match(JSON.stringify(body.messages[0]), /Przy dobieraniu zapasu osłon na stoisko na jutro/);
        return streamReply({ name: "aktualnyCzas", id: "booth-clock" });
      }
      if (modelCalls === 2) {
        assert.match(priorResults, /30\.11\.2026/);
        if (limit) {
          assert.equal(body.tool_choice, "none");
          return streamReply({ text: "" });
        }
        return streamReply({ name: "pogoda", id: "booth-weather", input: { miasto: "Kraków", kraj: "PL", data: "2026-12-01" } });
      }
      if (rain === null) {
        assert.equal(body.tool_choice, "none");
        assert.match(priorResults, /nie udostępniło prognozy/);
        return streamReply({ text: "" });
      }
      const perShift = rain >= 50 ? 20 : 5;
      if (modelCalls === 3) {
        assert.ok(priorResults.includes(`"prawdopodobienstwoOpadowProc":${rain}`) ||
          priorResults.includes(`\\"prawdopodobienstwoOpadowProc\\":${rain}`));
        return streamReply({ name: "kalkulator", id: "booth-calc", input: { operacja: "pomnoz", a: perShift, b: 4 } });
      }
      assert.match(priorResults, new RegExp(`wynik.+${perShift * 4}`));
      return streamReply({ text: `1 grudnia w Krakowie szansa opadów to ${rain}%. ${perShift} × 4 = ${perShift * 4} osłon.` });
    });

    const chat = limit ? client([], headers(), undefined, async (request) =>
      chatResponse(request, await request.json(), performance.now(), limit)) : client();
    await chat.sendMessage({ text: boothRequest });
    const answer = chat.messages.at(-1);
    const text = answer.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
    assert.equal(chat.status, "ready");
    assert.deepEqual(answer.metadata.toolSteps, expectedTools.map((tool, index) => ({ step: index + 1, tools: [tool] })));
    assert.equal(modelCalls, expectedTools.length + 1);
    assert.equal(forecastCalls, limit ? 0 : 1);
    if (limit) {
      assert.match(text, /Zatrzymałem się po 2 krokach/);
      assert.match(text, /Zebrane informacje:\n• 30\.11\.2026/);
    } else if (rain === null) {
      assert.match(text, /Krok 2:.*pogoda.*Open-Meteo nie udostępniło prognozy/);
      assert.match(text, /Zebrane informacje:\n• 30\.11\.2026/);
    } else {
      assert.match(text, new RegExp(`szansa opadów to ${rain}%`));
      assert.match(text, /× 4 = (80|20) osłon/);
    }
  });
}

const shippingRequest = "Policz, ile paczek możemy wysłać w Polsce od jutra do końca miesiąca. Nadajemy od poniedziałku do piątku, z wyłączeniem dni ustawowo wolnych. Dzienny limit to 40 paczek.";

function mockShippingModel(t, summary) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-22T12:00:00Z") });
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (new URL(url).hostname === "nagerholidays.com") {
      assert.equal(new URL(url).pathname, "/api/v4/Holidays/PL/2026");
      return Response.json([{ date: "2026-11-11", name: "Independence Day", nationalHoliday: true, subdivisionCodes: null, holidayTypes: ["Public"] }]);
    }
    const { messages } = JSON.parse(options.body);
    const priorResults = JSON.stringify(messages.filter(({ role }) => role === "tool"));
    if (++modelCalls === 1) return streamReply({ name: "aktualnyCzas", id: "clock" });
    if (modelCalls === 2) {
      assert.match(priorResults, /22\.11\.2026/);
      return streamReply({ name: "swieta", input: { kraj: "PL", rok: 2026 }, id: "holidays" });
    }
    if (modelCalls === 3) {
      assert.match(priorResults, /2026-11-11/);
      return streamReply({ name: "kalkulator", input: { operacja: "pomnoz", a: 6, b: 40 }, id: "capacity" });
    }
    assert.match(priorResults, /240/);
    return summary();
  });
}

test("plan wysyłek używa kolejno czasu, świąt i kalkulatora", async (t) => {
  mockShippingModel(t, () => streamReply({ text: "Od 23 do 30 listopada jest sześć dni nadawania. Możecie wysłać 240 paczek." }));
  const chat = client();
  await chat.sendMessage({ text: shippingRequest });
  const answer = chat.messages.at(-1);
  assert.equal(chat.status, "ready");
  assert.deepEqual(answer.metadata.toolSteps, [
    { step: 1, tools: ["aktualnyCzas"] }, { step: 2, tools: ["swieta"] }, { step: 3, tools: ["kalkulator"] },
  ]);
  assert.equal(answer.metadata.statistics.toolCalls, 3);
  assert.equal(answer.metadata.statistics.steps, 4);
  assert.equal(answer.parts.find(({ type }) => type === "text").text, "Od 23 do 30 listopada jest sześć dni nadawania. Możecie wysłać 240 paczek.");
});

for (const [caseName, summary] of [
  ["błąd modelu", () => Response.json({ error: { message: "SZCZEGÓŁY AWARII DOSTAWCY" } }, { status: 503 })],
  ["ucięte podsumowanie", () => streamReply({ text: "NIEDOKOŃCZONY FRAGMENT", finishReason: "length" })],
  ["puste podsumowanie", () => streamReply({ text: "" })],
]) {
  test(`plan wysyłek podaje końcowy wynik z kalkulatora po kroku 4: ${caseName}`, async (t) => {
    mockShippingModel(t, summary);
    const chat = client();
    await chat.sendMessage({ text: shippingRequest });
    const answer = chat.messages.at(-1);
    const text = answer.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
    assert.equal(chat.status, "ready");
    assert.equal(answer.metadata.statistics.steps, 4);
    assert.deepEqual(answer.metadata.usedTools, ["aktualnyCzas", "swieta", "kalkulator"]);
    assert.match(text, /^Możecie wysłać 240 paczek\./);
    assert.match(text, /6 × 40 = 240/);
    assert.match(text, /liczbę dni nadawania przez dzienny limit/);
    assert.match(text, /nie dokończył podsumowania w kroku 4/);
    assert.doesNotMatch(text, /SZCZEGÓŁY AWARII DOSTAWCY|NIEDOKOŃCZONY FRAGMENT/);
  });
}

test("awaria modelu w drugim kroku pokazuje numer kroku i zachowuje datę", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-22T12:00:00Z") });
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async () => ++modelCalls === 1
    ? streamReply({ name: "aktualnyCzas", id: "clock" })
    : Response.json({ error: { message: "SZCZEGÓŁY AWARII DOSTAWCY" } }, { status: 503 }));
  const chat = client();
  await chat.sendMessage({ text: shippingRequest });
  const answer = chat.messages.at(-1);
  const text = answer.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.equal(chat.status, "ready");
  assert.equal(modelCalls, 2);
  assert.equal(answer.metadata.statistics.steps, 2);
  assert.equal(answer.metadata.statistics.toolCalls, 1);
  assert.match(text, /Zadanie przerwało się na kroku 2/);
  assert.match(text, /Zebrane informacje:\n• 22\.11\.2026/);
  assert.doesNotMatch(text, /SZCZEGÓŁY AWARII DOSTAWCY/);
});

test("w trybie deweloperskim limit 16 obejmuje wywołania w jednym kroku i natywne wyszukiwanie", async (t) => {
  const environment = process.env.NODE_ENV;
  t.after(() => { process.env.NODE_ENV = environment; });
  process.env.NODE_ENV = "development";
  let modelCalls = 0;
  let apiCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname === "api.nbp.pl") {
      apiCalls++;
      const date = new URL(url).pathname.split("/").at(-2);
      return Response.json({ code: "EUR", rates: [{ mid: 4.25, effectiveDate: date }] });
    }
    const body = JSON.parse(options.body);
    assert.equal(body.max_tool_calls, 1);
    if (++modelCalls === 1) return streamReply({
      sources: ["https://example.com/a", "https://example.com/b"],
      calls: Array.from({ length: 20 }, (_, index) => ({
        name: "waluty", input: { waluta: "EUR", kwota: index }, id: `rate-${index}`,
      })),
    });
    assert.equal(body.tool_choice, "none");
    assert.ok(!body.tools.some(({ type }) => type === "openrouter:web_search"));
    return streamReply();
  };
  const chat = client();
  await chat.sendMessage({ text: "Wyszukaj informacje i przelicz kwoty." });
  const answer = chat.messages.at(-1);
  assert.equal(chat.status, "ready");
  assert.equal(modelCalls, 2);
  assert.equal(apiCalls, 15);
  assert.equal(answer.metadata.statistics.toolCalls, 16);
  assert.equal(answer.metadata.statistics.steps, 2);
  assert.equal(answer.metadata.usedTools.length, 16);
  assert.ok(answer.parts.some((part) => part.type === "text" && part.text.includes("Zatrzymałem się po 16 wywołaniach")));
});

test("Stop anuluje aktywne żądanie modelu i zachowuje tekst oraz wynik narzędzia", async (t) => {
  let modelCalls = 0;
  const pending = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    if (++modelCalls === 1) return streamReply({
      name: "kalkulator", input: { operacja: "dodaj", a: 2, b: 3 }, prefixText: "Zacząłem obliczenia.",
    });
    pending.resolve(signal);
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const chat = client([], headers(), ({ isAbort, message }) => {
    if (isAbort) chat.messages = markChatInterrupted(chat.messages, message);
  });
  const receivedResult = Promise.withResolvers();
  const unsubscribe = chat["~registerMessagesCallback"](() => {
    if (chat.messages.at(-1)?.metadata?.partialResults?.length) receivedResult.resolve();
  });
  t.after(unsubscribe);
  const response = chat.sendMessage({ text: "Oblicz, ile to 2 + 3." });
  const [signal] = await Promise.all([pending.promise, receivedResult.promise]);
  await chat.stop();
  await response;
  assert.equal(signal.aborted, true);
  assert.equal(chat.status, "ready");
  assert.equal(modelCalls, 2);
  assert.equal(chat.messages.length, 2);
  const answer = chat.messages.at(-1);
  assert.equal(answer.metadata.interrupted, true);
  assert.deepEqual(answer.metadata.partialResults, ["Wynik obliczenia: 5."]);
  assert.ok(answer.parts.some((part) => part.type === "text" && part.text === "Zacząłem obliczenia."));
});

test("Stop przed pierwszą odpowiedzią zostawia dopisek i można wysłać kolejną wiadomość", async (t) => {
  let modelCalls = 0;
  const pending = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    if (++modelCalls > 1) return streamReply();
    pending.resolve(signal);
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const browserRequests = [];
  const chat = client(browserRequests, headers(), ({ isAbort, message }) => {
    if (isAbort) chat.messages = markChatInterrupted(chat.messages, message);
  });
  const response = chat.sendMessage({ text: "Zacznij pracę." });
  const signal = await pending.promise;
  await chat.stop();
  await response;
  assert.equal(signal.aborted, true);
  assert.equal(chat.messages.at(-1).metadata.interrupted, true);
  await chat.sendMessage({ text: "Nowe pytanie." });
  assert.equal(chat.status, "ready");
  assert.equal(chat.messages.at(-1).parts.find((part) => part.type === "text").text, "Gotowe.");
  assert.equal(browserRequests[1].messages.length, 2);
});

test("po błędzie pomija powtórzenie w kolejce i pokazuje wynik częściowy oraz przyczynę", async () => {
  let modelCalls = 0;
  let weatherCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname === "geocoding-api.open-meteo.com") {
      weatherCalls++;
      return Response.json({});
    }
    if (++modelCalls === 1) return streamReply({ calls: [
      { name: "kalkulator", input: { operacja: "dodaj", a: 2, b: 3 }, id: "calc" },
      { name: "pogoda", input: { miasto: "Nieistniejące miasto" }, id: "weather" },
      { name: "pogoda", input: { miasto: "Nieistniejące miasto" }, id: "weather-repeat" },
    ] });
    assert.equal(JSON.parse(options.body).tool_choice, "none");
    return streamReply({ text: "" });
  };
  const chat = client();
  await chat.sendMessage({ text: "Oblicz 2 + 3 i sprawdź pogodę." });
  const answer = chat.messages.at(-1);
  const text = answer.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.equal(chat.status, "ready");
  assert.equal(weatherCalls, 1);
  assert.equal(modelCalls, 2);
  assert.equal(answer.metadata.statistics.toolCalls, 2);
  assert.deepEqual(answer.metadata.usedTools, ["kalkulator", "pogoda"]);
  assert.match(text, /Krok 1: nie udało się wykonać narzędzia/);
  assert.match(text, /Nie znaleziono takiego miasta/);
  assert.match(text, /Wynik obliczenia: 5/);
});

test("przekroczenie czasu narzędzia pokazuje czytelny błąd i przerywa ponawianie", async (t) => {
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (ms) => originalTimeout(ms === 10_000 ? 40 : ms));
  let modelCalls = 0;
  let weatherCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname === "geocoding-api.open-meteo.com") {
      weatherCalls++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return Response.json({});
    }
    if (++modelCalls === 1) return streamReply({ name: "pogoda", input: { miasto: "Warszawa" } });
    assert.equal(JSON.parse(options.body).tool_choice, "none");
    return streamReply({ text: "" });
  };
  const chat = client();
  await chat.sendMessage({ text: "Sprawdź pogodę w Warszawie." });
  const answer = chat.messages.at(-1);
  const weather = answer.parts.find((part) => part.type === "tool-pogoda");
  assert.equal(weather.state, "output-error");
  assert.equal(weather.errorText, "źródło nie odpowiada");
  assert.equal(weatherCalls, 1);
  assert.equal(modelCalls, 2);
  assert.equal(answer.metadata.statistics.toolCalls, 1);
});

test("limit czasu całego zadania kończy strumień ze statystykami i zebranym wynikiem", async (t) => {
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (ms) => originalTimeout(ms > 59_000 ? 45 : ms));
  let modelCalls = 0;
  globalThis.fetch = async () => {
    if (++modelCalls === 1) return streamReply({ name: "kalkulator", input: { operacja: "dodaj", a: 2, b: 3 } });
    await new Promise((resolve) => setTimeout(resolve, 70));
    return streamReply();
  };
  const chat = client();
  await chat.sendMessage({ text: "Zbierz wyniki po obliczeniu." });
  const answer = chat.messages.at(-1);
  const text = answer.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.equal(answer.metadata.statistics.steps, 2);
  assert.equal(answer.metadata.statistics.toolCalls, 1);
  assert.match(text, /Zatrzymałem się po 60 sekundach/);
  assert.match(text, /Wynik obliczenia: 5/);
});

test("limit czasu wyszukiwania natywnego przerywa żądanie do OpenRouter", async (t) => {
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (ms) => originalTimeout(ms === 10_000 ? 35 : ms));
  let signal;
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    await new Promise((resolve) => setTimeout(resolve, 70));
    return streamReply();
  };
  const chat = client();
  await chat.sendMessage({ text: "Wyszukaj informacje." });
  const answer = chat.messages.at(-1);
  assert.equal(chat.status, "ready");
  assert.equal(signal.aborted, true);
  assert.equal(answer.metadata.statistics.steps, 1);
  assert.equal(answer.metadata.statistics.toolCalls, 0);
  assert.ok(answer.parts.some((part) => part.type === "text" && part.text.includes("źródło nie odpowiada")));
});

test("walidacja opisów obrazu, odmowa oraz brak identyfikatora z API", async () => {
  for (const value of [null, {}, { prompt: 5 }, { prompt: " " }, { prompt: "x".repeat(501) }, { prompt: "Kot", extra: true }]) {
    assert.equal(validateImagePrompt(value).success, false);
  }
  assert.equal(validateImagePrompt({ prompt: "🐈".repeat(500) }).success, true);
  globalThis.fetch = async () => Response.json({ choices: [{ message: { images: [{ image_url: { url: imageUrl } }] } }] });
  const result = await generatePicture({ apiKey: "test-only-key", prompt: "Kot", signal: new AbortController().signal });
  assert.equal(result.modelId, null);
  for (const [payload, expected] of [[{ choices: [{ message: { content: "Odmowa", images: [] } }] }, imageFailureMessages.empty],
    [{ choices: [{ message: { images: [{ image_url: { url: "https://obca.example/image.png" } }] } }] }, imageFailureMessages.format]]) {
    globalThis.fetch = async () => Response.json(payload);
    await assert.rejects(generatePicture({ apiKey: "test-only-key", prompt: "Kot", signal: new AbortController().signal }), { message: expected });
  }
});

test("błędny opis wygenerowany przez agenta pokazuje błąd parametrów i nie wywołuje obrazu", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.modalities, undefined, "Błędny opis nie może uruchomić płatnego generowania");
    return ++calls === 1 ? streamReply({ name: "generujObraz", input: { prompt: "x".repeat(501) } }) : streamReply();
  };
  const chat = client();
  await chat.sendMessage({ text: "Wygeneruj wnętrze salonu z kuchnią i jadalnią." });
  assert.equal(chat.status, "ready");
  const part = chat.messages.at(-1).parts.find((part) => part.type === "tool-generujObraz");
  assert.equal(part.state, "output-error");
  assert.equal(part.errorText, imageFailureMessages.input);
});
