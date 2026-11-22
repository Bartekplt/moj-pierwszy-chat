import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/dashboard/route.ts";
import { createSession, SESSION_COOKIE } from "../lib/server/session.ts";
import { getMonthlyCurrencyRate } from "../lib/server/nbp-rates.ts";
import { readTravelEvents, travelStreamType } from "../lib/travel-dashboard-stream.ts";

process.env.CHAT_PASSWORD = "test-only-password";
process.env.SESSION_SECRET = "test-only-session-secret-with-at-least-32-characters";
process.env.OPENROUTER_API_KEY = "test-only-key";
process.env.OPENROUTER_MODEL = "test/model";

const query = { city: "Tokio", date: "2026-12-31" };
const request = (body = query, { authenticated = true, origin = "http://localhost", accept = "application/json" } = {}) => new Request("http://localhost/api/dashboard", {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json", Accept: accept, ...(authenticated && { Cookie: `${SESSION_COOKIE}=${createSession()}` }) },
  body: JSON.stringify(body),
});
const holiday = (date, name, nationalHoliday = true) => ({ date, name, nationalHoliday, subdivisionCodes: null, holidayTypes: ["Public"] });

function mockSources(t, { noCity = false, broken = false, mszDown = false, rateLookupFallback = false, mszResponse, summaryReply,
  compare = false, compareMissing = false } = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const address = new URL(url);
    calls.push(address);
    if (address.hostname !== "openrouter.ai") {
      assert.equal(options.cache, "no-store");
      assert.equal(new Headers(options.headers).has("Cookie"), false);
      assert.equal(new Headers(options.headers).has("Authorization"), false);
    }
    switch (address.hostname) {
      case "geocoding-api.open-meteo.com":
        if (compare && address.searchParams.get("name") === "Osaka") return Response.json(compareMissing ? {} : { results: [{
          name: "Osaka", country: "Japonia", country_code: "JP", latitude: 34.69, longitude: 135.5, timezone: "Asia/Tokyo",
        }] });
        assert.equal(address.searchParams.get("name"), "Tokio");
        return Response.json(noCity ? {} : { results: [{
          name: "Tokio", country: "Japonia", country_code: "JP", latitude: 35.68, longitude: 139.69, timezone: "Asia/Tokyo",
        }] });
      case "api.open-meteo.com":
        assert.equal(address.searchParams.get("start_date"), query.date);
        assert.equal(address.searchParams.get("end_date"), query.date);
        if (broken) return new Response(null, { status: 400 });
        return Response.json({ timezone: "Asia/Tokyo", daily: {
          time: [query.date], weather_code: [61], temperature_2m_min: [3], temperature_2m_max: [10],
          precipitation_probability_max: [address.searchParams.get("latitude") === "34.69" ? 20 : 75],
        } });
      case "api.nbp.pl":
        if (address.pathname.endsWith("/2026-11-23/2026-12-22/")) {
          assert.equal(address.searchParams.get("format"), "json");
          if (rateLookupFallback) return new Response(null, { status: 404 });
        }
        assert.equal(address.pathname, `/api/exchangerates/rates/a/jpy/${rateLookupFallback ? "last/30/" : "2026-11-23/2026-12-22/"}`);
        return Response.json({ code: "JPY", rates: [
          { mid: 0.02, effectiveDate: "2026-11-23" },
          { mid: 0.024, effectiveDate: "2026-12-21" },
          { mid: 0.08, effectiveDate: "2026-11-22" },
          { mid: 0.09, effectiveDate: "2026-12-23" },
          { mid: 0.028, effectiveDate: "2026-12-22" },
        ] });
      case "nagerholidays.com":
        if (address.pathname.endsWith("/2026")) return Response.json([
          holiday("2026-12-21", "Past Holiday"), holiday("2026-12-31", "Regional Holiday", false),
        ]);
        assert.equal(address.pathname, "/api/v4/Holidays/JP/2027");
        return Response.json([holiday("2027-02-11", "Foundation Day"), holiday("2027-01-01", "New Year's Day")]);
      case "pl.wikipedia.org":
        if (compare && address.searchParams.get("titles") === "Osaka") {
          return Response.json({ query: { pages: [{ title: "Osaka", ns: 0, pageid: 124, extract: "Osaka leży w Japonii." }] } });
        }
        assert.equal(address.searchParams.get("titles"), "Tokio");
        assert.equal(address.searchParams.get("exsentences"), "2");
        return Response.json({ query: { pages: [{ title: "Tokio", ns: 0, pageid: 123, extract: "Tokio to stolica Japonii. Leży na wyspie Honsiu." }] } });
      case "odyseusz.gov.pl":
        assert.equal(address.pathname, "/api/v1/informacje/profile-panstw/JP");
        if (mszResponse) return mszResponse;
        if (mszDown) return new Response(null, { status: 503 });
        return Response.json({ kodISO: "JP", dataAktualizacji: "2026-10-01", ostrzezenia: [
          { poziomZagrozenia: { opis: "Poziom 1 - Zwykła ostrożność" }, zakresTerytorialnyOstrzezenia: { kod: "BAZOWY_DLA_KRAJU" }, regiony: [] },
          { poziomZagrozenia: { opis: "Testowy komunikat regionalny" }, zakresTerytorialnyOstrzezenia: { kod: "SZCZEGOLOWY_DLA_REGIONU" },
            regiony: [{ obszarAdministracyjny: { podzialAdministracyjny1: "Region testowy", podzialAdministracyjny2: "Dystrykt testowy" } }],
          },
        ] });
      case "openrouter.ai": {
        if (broken) return new Response(null, { status: 503 });
        const { messages, tools } = JSON.parse(options.body);
        assert.ok(!tools?.length);
        if (compare) {
          assert.deepEqual(JSON.parse(messages.at(-1).content), [{ id: 1, przemawiaZa: "Osaka", fakt: "Prognozowana szansa opadów: Tokio — 75%, Osaka — 20%." }]);
          return Response.json({ id: "test", created: 0, model: "test/model", choices: [{ index: 0, finish_reason: "stop",
            message: { role: "assistant", content: "1" } }] });
        }
        assert.deepEqual(JSON.parse(messages.at(-1).content), {
          prognoza: { warunki: "słaby deszcz", odC: 3, doC: 10, szansaOpadowProcent: 75 },
          ogolnokrajowyDzienWolnyWTerminieLubDoDwochDniPo: true,
        });
        return Response.json({ id: "test", created: 0, model: "test/model", choices: [{ index: 0, finish_reason: summaryReply?.reason ?? "stop", message: {
          role: "assistant", content: summaryReply?.text ?? "Spakuj ciepłą kurtkę przeciwdeszczową. Sprawdź godziny otwarcia w Nowy Rok.",
        } }] });
      }
      default: return assert.fail(`Nieoczekiwane źródło ${address.hostname}`);
    }
  });
  return calls;
}

test("API podróży wymaga sesji przed odczytem i waliduje formularz oraz pochodzenie", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Nie wolno wykonywać żądań"); });
  assert.equal((await POST(request(null, { authenticated: false }))).status, 401);
  assert.equal((await POST(request(query, { origin: "https://inna.example" }))).status, 403);
  assert.equal((await POST(request({ city: " ", date: "2026-02-30" }))).status, 400);
  assert.equal((await POST(request({ ...query, compareCity: " tokio " }))).status, 400);
  assert.equal(fetch.mock.callCount(), 0);
});

test("porównanie wysyła oba zestawy kart i poleca miasto na podstawie prognozy", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-22T12:00:00Z") });
  const calls = mockSources(t, { compare: true });
  const response = await POST(request({ ...query, compareCity: "Osaka" }, { accept: travelStreamType }));
  assert.equal(response.status, 200);
  const events = [];
  await readTravelEvents(response.body, (event) => events.push(event));
  assert.deepEqual(events.filter(({ type }) => type === "destination").map(({ cityIndex, destination }) =>
    [cityIndex, destination.city, destination.date]).sort(), [[0, "Tokio", query.date], [1, "Osaka", query.date]]);
  assert.equal(events.filter(({ type, cityIndex }) => type === "cards" && cityIndex === 0).length, 6);
  assert.equal(events.filter(({ type, cityIndex }) => type === "cards" && cityIndex === 1).length, 6);
  assert.equal(calls.filter(({ hostname }) => hostname === "openrouter.ai").length, 1);
  assert.deepEqual(events.at(-1), { type: "recommendation", recommendation: {
    cityIndex: 1, reasons: ["Prognozowana szansa opadów: Tokio — 75%, Osaka — 20%."],
  } });
});

test("błędne drugie miasto nie usuwa kart pierwszego ani nie wymusza rekomendacji", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-22T12:00:00Z") });
  const calls = mockSources(t, { compare: true, compareMissing: true });
  const response = await POST(request({ ...query, compareCity: "Osaka" }, { accept: travelStreamType }));
  const events = [];
  await readTravelEvents(response.body, (event) => events.push(event));
  assert.ok(events.some(({ type, cityIndex }) => type === "error" && cityIndex === 1));
  assert.equal(events.filter(({ type, cityIndex }) => type === "cards" && cityIndex === 0).length, 6);
  assert.equal(calls.filter(({ hostname }) => hostname === "openrouter.ai").length, 0);
  assert.equal(events.at(-1).recommendation.cityIndex, null);
});

test("panel pobiera sześć kart, liczy różnicę czasu, zwraca podsumowanie i odświeża dane", async (t) => {
  const start = new Date("2026-12-22T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const calls = mockSources(t);
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const data = await response.json();
  assert.deepEqual(data.destination, { ...query, country: "Japonia" });
  assert.equal(data.weather.temperaturaMinC, 3);
  assert.ok(Math.abs(data.currency.kursPLN - 0.024) < 1e-12);
  assert.equal(data.currency.liczbaNotowan, 3);
  assert.equal(data.currency.odDnia, "2026-11-23");
  assert.equal(data.currency.doDnia, "2026-12-22");
  assert.deepEqual(data.holidays.dniWolne.map(({ data }) => data), ["2027-01-01", "2027-02-11"]);
  assert.equal(data.wiki.url, "https://pl.wikipedia.org/?curid=123");
  assert.equal(data.time.godzina, "21:00:00");
  assert.equal(data.time.roznicaMin, 8 * 60);
  assert.equal(data.msz.url, "https://odyseusz.gov.pl/JP");
  assert.equal(data.msz.updated, "2026-10-01");
  assert.deepEqual(data.msz.warnings, [
    { level: "Poziom 1 - Zwykła ostrożność", national: true, regions: [] },
    { level: "Testowy komunikat regionalny", national: false, regions: ["Dystrykt testowy, Region testowy"] },
  ]);
  assert.equal(data.summary.fromAgent, true);
  assert.deepEqual(data.summary.missingSources, []);
  assert.match(data.summary.text, /kurtkę przeciwdeszczową/);
  assert.equal(calls.filter(({ hostname }) => hostname === "geocoding-api.open-meteo.com").length, 1);

  t.mock.timers.setTime(start.getTime() + 2000);
  const updated = await (await POST(request())).json();
  for (const card of ["weather", "currency", "holidays", "wiki", "time", "msz"]) {
    assert.equal(data[card].pobrano, "2026-12-22T12:00:00.000Z");
    assert.equal(updated[card].pobrano, "2026-12-22T12:00:02.000Z");
  }
  assert.equal(calls.filter(({ hostname }) => hostname === "geocoding-api.open-meteo.com").length, 2);
  assert.equal(calls.filter(({ hostname }) => hostname === "odyseusz.gov.pl").length, 2);
});

test("brak prognozy i błędne podsumowanie nie blokują pozostałych kart", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-22T12:00:00Z") });
  mockSources(t, { broken: true });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.weather.blad, /Brak prognozy/);
  assert.equal(data.currency.waluta, "JPY");
  assert.equal(data.time.strefa, "Asia/Tokyo");
  assert.equal(data.summary.fromAgent, false);
  assert.equal(data.summary.text, null);
  assert.deepEqual(data.summary.missingSources, ["Open-Meteo"]);
});

test("podsumowanie zachowuje pełne zdania, a usuwa urwany fragment odpowiedzi", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-22T12:00:00Z") });
  const full = "Spakuj parasol lub kurtkę przeciwdeszczową oraz cieplejsze ubrania.";
  const summaryReply = { reason: "length", text: `${full} Uważaj` };
  mockSources(t, { summaryReply });
  assert.equal((await (await POST(request())).json()).summary.text, full);

  summaryReply.reason = "stop";
  assert.equal((await (await POST(request())).json()).summary.text, full);

  summaryReply.text = "Przygotuj się na";
  const data = await (await POST(request())).json();
  assert.equal(data.summary.text, null);
  assert.equal(data.weather.temperaturaMinC, 3);
});

test("nieznane miasto kończy zapytanie bez modelu", async (t) => {
  const calls = mockSources(t, { noCity: true });
  const response = await POST(request());
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /Nie znaleziono takiego miasta/);
  assert.equal(calls.length, 1);
});

test("awaria portalu MSZ zostawia link do kraju i dane z pozostałych źródeł", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-22T12:00:00Z") });
  mockSources(t, { mszDown: true });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.msz.blad, /Nie udało się pobrać aktualnych zaleceń/);
  assert.equal(data.msz.url, "https://odyseusz.gov.pl/JP");
  assert.equal(data.weather.temperaturaMinC, 3);
  assert.equal(data.summary.fromAgent, true);
  assert.deepEqual(data.summary.missingSources, ["MSZ · Odyseusz"]);
});

test("strumień udostępnia pięć gotowych kart przed awarią szóstego źródła", { timeout: 3000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-22T12:00:00Z") });
  const source = Promise.withResolvers();
  mockSources(t, { mszResponse: source.promise });
  const response = await POST(request(query, { accept: travelStreamType }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
  const events = [];
  const firstFive = Promise.withResolvers();
  const parsing = readTravelEvents(response.body, (event) => {
    events.push(event);
    if (events.filter(({ type }) => type === "cards").length === 5) firstFive.resolve();
  });
  await firstFive.promise;
  assert.equal(events[0].type, "destination");
  const ready = Object.assign({}, ...events.filter(({ type }) => type === "cards").map(({ cards }) => cards));
  assert.deepEqual(Object.keys(ready).sort(), ["currency", "holidays", "time", "weather", "wiki"]);
  assert.ok(Object.values(ready).every((card) => !("blad" in card)));
  assert.ok(!events.some(({ type }) => type === "summary"));
  source.reject(new Error("Testowa awaria MSZ"));
  await parsing;
  assert.ok(events.find(({ type, cards }) => type === "cards" && cards.msz).cards.msz.blad);
  assert.deepEqual(events.at(-1).summary.missingSources, ["MSZ · Odyseusz"]);
});

test("gdy NBP odrzuca zakres dat, karta liczy średnią z ostatnich notowań mieszczących się w okresie", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-22T12:00:00Z") });
  const calls = mockSources(t, { rateLookupFallback: true });
  const data = await (await POST(request())).json();
  assert.equal(data.currency.liczbaNotowan, 3);
  assert.ok(Math.abs(data.currency.kursPLN - 0.024) < 1e-12);
  assert.equal(calls.filter(({ hostname }) => hostname === "api.nbp.pl").length, 2);
});

test("porównanie walut odczytuje JPY z tabeli A, gdy oba zapytania o samą walutę zwracają 404", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-22T12:00:00Z") });
  const paths = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    paths.push(url.pathname);
    if (url.pathname.includes("/rates/a/jpy/")) return new Response(null, { status: 404 });
    if (url.pathname.includes("/rates/a/eur/")) return Response.json({ code: "EUR", rates: [{ mid: 4.2, effectiveDate: "2026-12-22" }] });
    assert.equal(url.pathname, "/api/exchangerates/tables/a/2026-11-23/2026-12-22/");
    return Response.json([
      { effectiveDate: "2026-11-22", rates: [{ code: "JPY", mid: 0.5 }] },
      { effectiveDate: "2026-11-23", rates: [{ code: "JPY", mid: 0.02 }, { code: "EUR", mid: 4.2 }] },
      { effectiveDate: "2026-12-22", rates: [{ code: "JPY", mid: 0.04 }, { code: "EUR", mid: 4.2 }] },
    ]);
  });
  const [tokio, berlin] = await Promise.all([getMonthlyCurrencyRate("JPY"), getMonthlyCurrencyRate("EUR")]);
  assert.equal(tokio.waluta, "JPY");
  assert.equal(tokio.kursPLN, 0.03);
  assert.equal(tokio.liczbaNotowan, 2);
  assert.equal(tokio.odDnia, "2026-11-23");
  assert.equal(tokio.doDnia, "2026-12-22");
  assert.equal(berlin.kursPLN, 4.2);
  assert.equal(paths.length, 4);
  assert.ok(!paths.some((path) => path.includes("/b/")));
});
