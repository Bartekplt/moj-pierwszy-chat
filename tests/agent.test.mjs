import assert from "node:assert/strict";
import test from "node:test";
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import ExcelJS from "exceljs";
import { JWT } from "google-auth-library";
import { POST } from "../app/api/agent/route.ts";
import { prepareAgentMessages } from "../lib/chat.ts";
import { createSession, SESSION_COOKIE } from "../lib/server/session.ts";
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
function streamReply({ name, input = {}, id = "call-1", sources = [], prefixText = "" } = {}) {
  const delta = name ? { tool_calls: [{ index: 0, id, type: "function", function: {
    name, arguments: JSON.stringify(input),
  } }], ...(prefixText ? { content: prefixText } : {}) } : { content: "Gotowe." };
  const data = (delta, finish_reason) => `data: ${JSON.stringify({
    id: "reply", model: "test/actual-chat-model", created: 0,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`;
  const annotations = sources.length ? data({ annotations: sources.map((url) => ({
    type: "url_citation", url_citation: { url, title: "Źródło testowe" },
  })) }, null) : "";
  return new Response(annotations + data(delta, null) + data({}, name ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}
function client(browserRequests = [], sessionHeaders = headers()) {
  return new Chat({ transport: new DefaultChatTransport({
    api: "/api/agent",
    prepareSendMessagesRequest: ({ messages }) => ({ body: { mode: "chat", messages: prepareAgentMessages(messages) } }),
    fetch: async (_url, options) => {
      browserRequests.push(JSON.parse(options.body));
      return POST(new Request("http://localhost/api/agent", { ...options, headers: sessionHeaders }));
    },
  }) });
}

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

test("agent kończy pętlę po pięciu krokach nawet przy kolejnych wywołaniach narzędzi", async () => {
  let calls = 0;
  globalThis.fetch = async () => streamReply({ name: "aktualnyCzas", id: `clock-${++calls}` });
  const chat = client();
  await chat.sendMessage({ text: "Jaki dziś dzień?" });
  assert.equal(chat.status, "ready");
  assert.equal(calls, 5);
  const answer = chat.messages.at(-1);
  assert.deepEqual(answer.metadata.usedTools, Array(5).fill("aktualnyCzas"));
  assert.equal(answer.parts.filter((part) => part.type === "text").map((part) => part.text).join(""), "Przerwałem po 5 krokach");
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
  assert.equal(calls, 4);
});

test("naturalne zakończenie odpowiedzi w piątym kroku nie jest oznaczane jako przerwanie", async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls < 5
    ? streamReply({ name: "aktualnyCzas", id: `clock-${calls}` }) : streamReply();
  const chat = client();
  await chat.sendMessage({ text: "Sprawdź daty i odpowiedz." });
  assert.equal(chat.status, "ready");
  assert.equal(calls, 5);
  const text = chat.messages.at(-1).parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.equal(text, "Gotowe.");
});

test("przy limicie zachowuje wcześniejszy tekst i dopisuje komunikat dokładnie raz", async () => {
  let calls = 0;
  globalThis.fetch = async () => streamReply({ name: "aktualnyCzas", id: `clock-${++calls}`,
    prefixText: calls === 1 ? "Zbieram informacje." : "" });
  const chat = client();
  await chat.sendMessage({ text: "Sprawdź daty." });
  const text = chat.messages.at(-1).parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.equal(text, "Zbieram informacje.\n\nPrzerwałem po 5 krokach");
  assert.equal(calls, 5);
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
