import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { z } from "zod";
import { getCurrentTime } from "./chat-tools.ts";
import { abortable, chatTimeoutMs, toolTimeoutMs } from "./chat-task.ts";
import { findCity, getCityForecast, getPublicHolidays, getWikipediaArticle } from "./public-data.ts";
import { getMszTravelAdvice } from "./msz-travel.ts";
import { getMonthlyCurrencyRate } from "./nbp-rates.ts";
import { toolFailure, toolResult } from "./tool-result.ts";
import { travelCurrencies } from "./travel-currencies.ts";
import { travelCardSources } from "../travel-dashboard-stream.ts";
import { recommendTravelCity, type TravelRecommendation } from "./travel-recommendation.ts";

const cityInput = z.string().trim().min(2).max(100).regex(/^[^|\x00-\x1f\x7f]+$/);
export const travelInput = z.strictObject({
  city: cityInput,
  compareCity: cityInput.optional(),
  date: z.iso.date().refine((date) => date >= "1900-01-01" && date <= "2100-12-31"),
}).refine(({ city, compareCity }) => !compareCity || city.toLocaleLowerCase("pl") !== compareCity.toLocaleLowerCase("pl"));

const polandZone = "Europe/Warsaw";
const polishCalendar = new Intl.DateTimeFormat("sv-SE", { timeZone: polandZone, year: "numeric", month: "2-digit", day: "2-digit" });
const sentences = new Intl.Segmenter("pl", { granularity: "sentence" });

export function travelToday() {
  return polishCalendar.format(new Date());
}

function zoneOffset(now: Date, timeZone: string) {
  const offset = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(now).find((part) => part.type === "timeZoneName")?.value;
  if (offset === "GMT") return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset ?? "");
  if (!match) throw new RangeError("Brak przesunięcia UTC");
  const [, sign, hours, minutes] = match;
  return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
}

function getLocalTime(timeZone?: string) {
  if (!timeZone) return toolFailure("Nie udało się ustalić strefy czasowej miasta.");
  try {
    const now = new Date();
    const roznicaMin = zoneOffset(now, timeZone) - zoneOffset(now, polandZone);
    return toolResult({ ...getCurrentTime(now, timeZone), roznicaMin }, now);
  } catch {
    return toolFailure("Brak danych o strefie czasowej miasta.");
  }
}

async function upcomingHolidays(country: string, date: string, signal: AbortSignal) {
  const year = Number(date.slice(0, 4));
  const current = await getPublicHolidays(country, year, signal);
  if ("blad" in current) return current;
  const upcoming = current.dniWolne.filter(({ data, ogolnokrajowe }) => data >= date && ogolnokrajowe)
    .sort((a, b) => a.data.localeCompare(b.data));
  if (upcoming.length >= 3 || year >= 2100) return toolResult({ dniWolne: upcoming.slice(0, 3), niepelne: false });

  const next = await getPublicHolidays(country, year + 1, signal);
  if ("blad" in next && !upcoming.length) return next;
  if ("blad" in next) return toolResult({ dniWolne: upcoming, niepelne: true });
  return toolResult({ dniWolne: [...upcoming, ...next.dniWolne.filter(({ ogolnokrajowe }) => ogolnokrajowe)
    .sort((a, b) => a.data.localeCompare(b.data))].slice(0, 3), niepelne: false });
}

async function summarize(
  date: string,
  { weather, holidays, time }: TravelCards,
  missingSources: string[],
  signal: AbortSignal,
): Promise<TravelSummary> {
  const travelDay = new Date(`${date}T00:00:00Z`);
  travelDay.setUTCDate(travelDay.getUTCDate() + 2);
  const hasNearHoliday = "dniWolne" in holidays && holidays.dniWolne.some(({ data }) => data <= travelDay.toISOString().slice(0, 10));
  const nearHoliday = hasNearHoliday ? true : "blad" in holidays || holidays.niepelne ? null : false;
  const forecast = "blad" in weather ? null : {
    warunki: weather.warunki,
    odC: weather.temperaturaMinC,
    doC: weather.temperaturaMaxC,
    szansaOpadowProcent: weather.prawdopodobienstwoOpadowProc,
  };
  const timeDifference = !forecast && "roznicaMin" in time ? time.roznicaMin : null;
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim();
  if (apiKey && model && (forecast || nearHoliday === true || timeDifference !== null)) {
    try {
      const summarySignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
      const { text, finishReason } = await abortable(summarySignal, () => generateText({
        model: createOpenRouter({ apiKey }).chat(model),
        instructions: "Napisz po polsku do dwóch krótkich zdań dla podróżnego: co spakować i na co uważać, jeśli wynikają z podanych danych. " +
          "Nie uzupełniaj braków domysłami. Nie wnioskuj o pogodzie ani dniach wolnych, jeśli ich dane mają wartość null. " +
          "Aplikacja osobno wymieni źródła bez danych. Jeśli nic nie możesz doradzić na podstawie danych, zwróć pustą odpowiedź. " +
          "Jeśli blisko terminu wypada dzień wolny, zasugeruj sprawdzenie godzin otwarcia. Dodatnia różnica czasu oznacza, że na miejscu jest później niż w Polsce. " +
          "Zwróć tylko pełne zdania zakończone kropką, bez listy i bez nagłówka.",
        prompt: JSON.stringify({ prognoza: forecast, ogolnokrajowyDzienWolnyWTerminieLubDoDwochDniPo: nearHoliday,
          ...(timeDifference !== null && { roznicaCzasuWMinutach: timeDifference }) }),
        maxOutputTokens: 1024,
        maxRetries: 0,
        abortSignal: summarySignal,
      }));
      if (finishReason === "stop" || finishReason === "length") {
        const completeSentences = [...sentences.segment(text.trim())]
          .map(({ segment }) => segment.trim())
          .filter((sentence) => /(?<!\.)[.!?][”"’')\]]*$/.test(sentence));
        if (completeSentences.length) return { text: completeSentences.slice(0, 2).join(" "), fromAgent: true, missingSources };
      }
    } catch {
      signal.throwIfAborted();
    }
  }

  return { text: null, fromAgent: false, missingSources };
}

type Failure = ReturnType<typeof toolFailure>;
export type TravelCards = {
  weather: Awaited<ReturnType<typeof getCityForecast>>;
  currency: Awaited<ReturnType<typeof getMonthlyCurrencyRate>>;
  holidays: Awaited<ReturnType<typeof upcomingHolidays>>;
  wiki: Awaited<ReturnType<typeof getWikipediaArticle>>;
  time: ReturnType<typeof getLocalTime>;
  msz: Awaited<ReturnType<typeof getMszTravelAdvice>> | Failure;
};
type TravelDestination = { city: string; country?: string; region?: string; date: string };
type TravelSummary = { text: string | null; fromAgent: boolean; missingSources: string[] };
type TravelCityEvent =
  | { type: "destination"; destination: TravelDestination }
  | { type: "cards"; cards: Partial<TravelCards> }
  | { type: "summary"; summary: TravelSummary }
  | { type: "error"; message: string };
export type TravelDashboardEvent = (TravelCityEvent & { cityIndex?: 0 | 1 })
  | { type: "recommendation"; recommendation: TravelRecommendation };

async function loadTravelCards(city: string, date: string, signal: AbortSignal,
  onEvent?: (event: TravelCityEvent) => void,
) {
  const location = await abortable(signal, () => findCity(city, undefined, signal));
  if ("blad" in location) return location;
  signal.throwIfAborted();
  const { place } = location;
  const destination = { city: place.name, country: place.country ?? place.country_code, region: place.admin1, date };
  onEvent?.({ type: "destination", destination });
  const currencyCode = travelCurrencies[place.country_code];

  async function publish<K extends keyof TravelCards>(key: K, run: (signal: AbortSignal) => TravelCards[K] | Promise<TravelCards[K]>) {
    const cardSignal = AbortSignal.any([signal, AbortSignal.timeout(toolTimeoutMs)]);
    const result = await abortable(cardSignal, () => run(cardSignal)).catch(() => toolFailure("Nie udało się pobrać danych ze źródła."));
    onEvent?.({ type: "cards", cards: { [key]: result } });
    return result;
  }

  const forecast = publish("weather", async (cardSignal) => {
    const weather = await getCityForecast(place, date, cardSignal);
    if ("blad" in weather) return weather;
    const readings = [weather.warunki, weather.temperaturaMinC, weather.temperaturaMaxC, weather.prawdopodobienstwoOpadowProc];
    return readings.every((value) => value === null) ? toolFailure("Open-Meteo nie zwróciło prognozy na wybrany dzień.") : weather;
  });
  const [weather, currency, holidays, wiki, time, msz] = await Promise.all([
    forecast,
    publish("currency", (cardSignal) => currencyCode ? getMonthlyCurrencyRate(currencyCode, cardSignal)
      : toolFailure("Brak informacji o walucie dla tego kraju.")),
    publish("holidays", (cardSignal) => upcomingHolidays(place.country_code, date, cardSignal)),
    publish("wiki", (cardSignal) => getWikipediaArticle(place.name, cardSignal, 2)),
    publish("time", async () => {
      if (place.timezone) return getLocalTime(place.timezone);
      const weather = await forecast;
      return getLocalTime("strefa" in weather ? weather.strefa : undefined);
    }),
    publish("msz", (cardSignal) => getMszTravelAdvice(place.country_code, cardSignal)),
  ]);
  signal.throwIfAborted();
  const cards: TravelCards = { weather, currency, holidays, wiki, time, msz };
  const missingSources: string[] = (Object.keys(cards) as (keyof TravelCards)[]).flatMap((key) =>
    "blad" in cards[key] ? [travelCardSources[key]] : []);
  if ("niepelne" in holidays && holidays.niepelne) missingSources.push(`${travelCardSources.holidays} (kolejny rok)`);
  return { destination, cards, missingSources, coordinates: `${place.latitude},${place.longitude}` };
}

export async function loadTravelDashboard(
  { city, date, compareCity }: z.infer<typeof travelInput>,
  requestSignal: AbortSignal,
  onEvent?: (event: TravelDashboardEvent) => void,
) {
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(chatTimeoutMs)]);
  if (compareCity) {
    async function getCity(name: string, cityIndex: 0 | 1) {
      const result = await loadTravelCards(name, date, signal, (event) => onEvent?.({ ...event, cityIndex }));
      if ("blad" in result) onEvent?.({ type: "error", message: result.blad, cityIndex });
      return result;
    }
    const cities = await Promise.all([getCity(city, 0), getCity(compareCity, 1)]);
    const [first, second] = cities;
    const recommendation: TravelRecommendation = "blad" in first || "blad" in second
      ? { cityIndex: null, reasons: ["Brakuje danych o jednym z miast, aby je porównać."] }
      : first.coordinates === second.coordinates
      ? { cityIndex: null, reasons: ["Obie nazwy wskazują to samo miasto. Wybierz inną miejscowość."] }
      : await recommendTravelCity([first, second], date, signal);
    onEvent?.({ type: "recommendation", recommendation });
    return { cities: cities.map((result) => "blad" in result ? result
      : { destination: result.destination, ...result.cards, missingSources: result.missingSources }), recommendation };
  }

  const result = await loadTravelCards(city, date, signal, onEvent);
  if ("blad" in result) return result;
  const { destination, cards, missingSources } = result;
  const summary = await summarize(date, cards, missingSources, signal);
  onEvent?.({ type: "summary", summary });
  return { destination, ...cards, summary };
}

export type TravelDashboardView = { destination: TravelDestination; cards: Partial<TravelCards>; summary?: TravelSummary; error?: string };
