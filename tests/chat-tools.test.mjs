import assert from "node:assert/strict";
import test from "node:test";
import { czas, getCurrentTime, kalkulator } from "../lib/server/chat-tools.ts";
import { createNotesTool } from "../lib/server/notes-tool.ts";
import { pogoda, swieta, waluty, wikipedia } from "../lib/server/public-data-tools.ts";
import { oswiadczeniaZdrowotneUE } from "../lib/server/health-claims-tool.ts";
import { createSession, SESSION_COOKIE } from "../lib/server/session.ts";

const execute = (tool, input) => tool.execute(tool.inputSchema.parse(input), { toolCallId: "test", messages: [] });

test("aktualnyCzas uwzględnia warszawską datę i dzień tygodnia po północy", () => {
  assert.deepEqual(getCurrentTime(new Date("2026-11-14T23:30:00Z")), {
    data: "15.11.2026", dzienTygodnia: "niedziela", godzina: "00:30:00", strefa: "Europe/Warsaw",
  });
});

test("aktualnyCzas uwzględnia zmianę czasu letniego i zimowego", () => {
  for (const [instant, expected] of [
    ["2026-03-29T00:59:59Z", "01:59:59"],
    ["2026-03-29T01:00:00Z", "03:00:00"],
    ["2026-10-25T00:30:00Z", "02:30:00"],
    ["2026-10-25T01:30:00Z", "02:30:00"],
  ]) assert.equal(getCurrentTime(new Date(instant)).godzina, expected);
});

test("lokalne narzędzia walidują argumenty i zwracają po polsku błędy obliczeń oraz stref", async () => {
  assert.equal(kalkulator.inputSchema.safeParse({ operacja: "eval", a: 2, b: 1 }).success, false);
  assert.equal(kalkulator.inputSchema.safeParse({ operacja: "dodaj", a: "2+1", b: 1 }).success, false);
  assert.match((await execute(kalkulator, { operacja: "podziel", a: 1, b: 0 })).blad, /dzielić przez zero/);
  assert.match((await execute(kalkulator, { operacja: "pomnoz", a: 1e308, b: 2 })).blad, /poza zakres/);
  assert.equal(getCurrentTime(new Date("2026-11-14T20:30:00Z"), "Asia/Tokyo").godzina, "05:30:00");
  assert.match((await execute(czas, { strefa: "Planeta/Mars" })).blad, /Nieznana strefa/);
});

test("notatki są widoczne w kolejnych żądaniach jednej sesji i odizolowane od pozostałych", async () => {
  process.env.CHAT_PASSWORD = "notes-test-password";
  process.env.SESSION_SECRET = "notes-test-secret-long-enough-for-session";
  const token = createSession();
  const notesTool = (cookie) => createNotesTool(new Request("http://localhost/api/agent", {
    headers: cookie ? { Cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  }));
  assert.equal(notesTool(token).inputSchema.safeParse({ operacja: "zapisz" }).success, false);
  assert.equal(notesTool(token).inputSchema.safeParse({ operacja: "pokaz", tresc: "nadmiar" }).success, false);
  assert.equal((await execute(notesTool(token), { operacja: "zapisz", tresc: "  Sprawdzić stan.  " })).zapisano, true);
  const result = await execute(notesTool(token), { operacja: "pokaz" });
  assert.equal(result.notatki[0].tresc, "Sprawdzić stan.");
  assert.deepEqual((await execute(notesTool(createSession()), { operacja: "pokaz" })).notatki, []);
  assert.match((await execute(notesTool(), { operacja: "pokaz" })).blad, /Sesja wygasła/);
});

test("Open-Meteo odróżnia brak miasta, niedostępny dzień i błąd dostawcy", async (t) => {
  let mode = "missing";
  t.mock.method(globalThis, "fetch", async (url) => {
    if (mode === "timeout") throw new DOMException("internal detail", "TimeoutError");
    if (mode === "missing") return Response.json({});
    if (url.hostname === "geocoding-api.open-meteo.com") {
      return Response.json({ results: [{ name: "Warszawa", latitude: 52.23, longitude: 21.01, country_code: "PL" }] });
    }
    return new Response("internal detail", { status: 400 });
  });
  assert.equal(pogoda.inputSchema.safeParse({ miasto: "Warszawa", data: "2026-02-30" }).success, false);
  assert.match((await execute(pogoda, { miasto: "Nieistniejące miasto" })).blad, /Nie znaleziono takiego miasta/);
  mode = "day";
  assert.match((await execute(pogoda, { miasto: "Warszawa", data: "2027-01-01" })).blad, /Brak prognozy/);
  mode = "timeout";
  const error = await execute(pogoda, { miasto: "Warszawa" });
  assert.match(error.blad, /Open-Meteo/);
  assert.ok(!JSON.stringify(error).includes("internal detail"));
});

test("NBP szuka kursu w tabeli B po 404 i przelicza również ze złotych", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-22T11:00:00Z") });
  const paths = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    paths.push(url.pathname);
    if (url.pathname === "/api/exchangerates/rates/b/isk/2026-11-08/2026-11-22/") return Response.json({
      code: "ISK", rates: [{ effectiveDate: "2026-11-18", mid: 0.025 }],
    });
    return new Response(null, { status: 404 });
  });
  const result = await execute(waluty, { waluta: "ISK", kwota: 250, kierunek: "zPLN" });
  assert.equal(result.wynik, 10_000);
  assert.equal(result.walutaWyniku, "ISK");
  assert.equal(result.tabela, "B");
  assert.deepEqual(paths, ["/api/exchangerates/rates/a/isk/2026-11-08/2026-11-22/", "/api/exchangerates/rates/b/isk/2026-11-08/2026-11-22/"]);
  assert.match((await execute(waluty, { waluta: "ZZZ" })).blad, /nie publikuje kursu/);
  assert.equal(waluty.inputSchema.safeParse({ waluta: "../../EUR" }).success, false);
});

test("NBP wybiera najnowszą publikację, pomija kurs z 2004 r. i poprawnie zaokrągla kwotę", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-21T23:30:00Z") });
  const stale = { effectiveDate: "2004-04-28", mid: 4.7805 };
  const future = { effectiveDate: "2026-11-23", mid: 9.5 };
  let rates = [stale, { effectiveDate: "2026-11-20", mid: 4.4559 }, future, { effectiveDate: "2026-11-19", mid: 4.4165 }];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.pathname, "/api/exchangerates/rates/a/eur/2026-11-08/2026-11-22/");
    assert.equal(options.cache, "no-store");
    return Response.json({ code: "EUR", rates });
  });
  const result = await execute(waluty, { waluta: "EUR", kwota: 250 });
  assert.equal(result.dataKursu, "2026-11-20");
  assert.equal(result.kursPLN, 4.4559);
  assert.equal(result.wynik, 1113.98);
  assert.equal(result.tabela, "A");
  rates = [stale, future];
  const unavailable = await execute(waluty, { waluta: "EUR", kwota: 250 });
  assert.match(unavailable.blad, /nie zwrócił aktualnego kursu EUR/);
  assert.equal(unavailable.kursPLN, undefined);
});

test("święta i Wikipedia obsługują nieznany kraj i nieistniejące hasło", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => url.hostname === "nagerholidays.com"
    ? new Response(null, { status: 404 })
    : Response.json({ query: { pages: [{ title: "Brak hasła", ns: 0, missing: true }] } }));
  assert.match((await execute(swieta, { kraj: "ZZ", rok: 2026 })).blad, /nie ma danych dla tego kraju lub roku/);
  assert.match((await execute(wikipedia, { haslo: "Brak hasła" })).blad, /Nie znaleziono takiego artykułu/);
  assert.equal(wikipedia.inputSchema.safeParse({ haslo: "Kraków|Warszawa" }).success, false);
});

test("rejestr UE waliduje składnik, łączy wpisy i rozróżnia brak wyniku od błędu eksportu", async (t) => {
  const tool = oswiadczeniaZdrowotneUE;
  assert.equal(tool.inputSchema.safeParse({ skladnik: "  " }).success, false);
  assert.equal(tool.inputSchema.safeParse({ skladnik: "<script>", status: "dopuszczone" }).success, false);
  assert.equal(tool.inputSchema.safeParse({ skladnik: "magnez", status: "inny" }).success, false);

  const base = {
    policy_item_code: "POL-HC-6144", nutrient_subst_food_no_html: "Magnesium",
    claim_status: "Non-authorised", claim: "<p>Improves&nbsp;skin condition.</p>", condition_of_use: null,
    restrictions_of_use: null, reasons_of_non_authorisation: "First reason", proprietary_data: "No", restriction_expiry_date: null,
  };
  let download = [base, { ...base, reasons_of_non_authorisation: "Another reason" }, {
    ...base, policy_item_code: "POL-HC-6145", nutrient_subst_food_no_html: "Magnesium and zinc",
  }].map((row) => JSON.stringify(row)).join("\r\n");
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).searchParams.has("skladnik"), false);
    assert.equal(options.cache, "no-store");
    return new Response(download);
  });
  const result = await execute(tool, { skladnik: "magnez", status: "niedopuszczone", fraza: "skin condition" });
  assert.equal(result.liczbaDopasowan, 2);
  assert.equal(result.wyniki[0].oswiadczenie, "Improves skin condition.");
  assert.deepEqual(result.wyniki[0].powodyNiedopuszczenia, ["First reason", "Another reason"]);
  assert.match((await execute(tool, { skladnik: "magnez", status: "dopuszczone" })).blad, /Nie znaleziono dopasowania/);
  download = "<html>Internal provider error</html>";
  const failure = await execute(tool, { skladnik: "magnez" });
  assert.match(failure.blad, /Nie udało się pobrać danych z rejestru/);
  assert.ok(!JSON.stringify(failure).includes("Internal provider error"));
});
