import { z } from "zod";
import { toolFailure, toolResult } from "./tool-result.ts";
import { fetchData } from "./fetch-public-data.ts";

export const countryCode = z.string().trim().regex(/^[a-z]{2}$/i).toUpperCase();
const geoResponse = z.object({ results: z.array(z.object({
  name: z.string(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  country_code: countryCode,
  country: z.string().optional(),
  admin1: z.string().optional(),
  timezone: z.string().optional(),
})).optional() });

type CityLocation = NonNullable<z.infer<typeof geoResponse>["results"]>[number];

export async function findCity(miasto: string, kraj?: string, signal?: AbortSignal) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.search = new URLSearchParams({ name: miasto, count: "1", language: "pl", ...(kraj && { countryCode: kraj }) }).toString();
  const location = await fetchData(url, geoResponse, signal);
  if (!location.ok) return toolFailure("Nie udało się wyszukać miasta w Open-Meteo. Spróbuj ponownie.");
  const place = location.data.results?.[0];
  return place ? toolResult({ place }) : toolFailure("Nie znaleziono takiego miasta. Sprawdź pisownię lub podaj kraj.");
}

const dailyValues = z.array(z.number().nullable());
const forecastResponse = z.object({
  timezone: z.string(),
  daily: z.object({
    time: z.array(z.iso.date()),
    weather_code: dailyValues,
    temperature_2m_min: dailyValues,
    temperature_2m_max: dailyValues,
    precipitation_probability_max: dailyValues,
  }),
});

const weatherDescriptions: Partial<Record<number, string>> = {
  0: "bezchmurnie", 1: "przeważnie pogodnie", 2: "częściowe zachmurzenie", 3: "pochmurno",
  45: "mgła", 48: "mgła osadzająca szadź",
  51: "słaba mżawka", 53: "umiarkowana mżawka", 55: "silna mżawka",
  56: "słaba marznąca mżawka", 57: "silna marznąca mżawka",
  61: "słaby deszcz", 63: "umiarkowany deszcz", 65: "silny deszcz",
  66: "słaby marznący deszcz", 67: "silny marznący deszcz",
  71: "słabe opady śniegu", 73: "umiarkowane opady śniegu", 75: "silne opady śniegu", 77: "śnieg ziarnisty",
  80: "słabe przelotne opady deszczu", 81: "umiarkowane przelotne opady deszczu", 82: "silne przelotne opady deszczu",
  85: "słabe przelotne opady śniegu", 86: "silne przelotne opady śniegu",
  95: "burza", 96: "burza z niewielkim gradem", 99: "burza z silnym gradem",
};

export async function getCityForecast(place: CityLocation, data?: string, abortSignal?: AbortSignal) {
  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.search = new URLSearchParams({
    latitude: String(place.latitude), longitude: String(place.longitude), timezone: "auto",
    daily: "weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max",
    ...(data ? { start_date: data, end_date: data } : { forecast_days: "1" }),
  }).toString();
  const forecast = await fetchData(forecastUrl, forecastResponse, abortSignal);
  const unavailableDay = "Brak prognozy na podany dzień. Podaj dzień z najbliższych 16 dni.";
  if (!forecast.ok) return toolFailure(data && forecast.status === 400
    ? unavailableDay : "Open-Meteo nie udostępniło prognozy. Spróbuj ponownie.");

  const { daily, timezone } = forecast.data;
  const day = data ? daily.time.indexOf(data) : 0;
  if (!daily.time[day]) return toolFailure(unavailableDay);
  const code = daily.weather_code[day];
  return toolResult({
    miasto: place.name, kraj: place.country ?? place.country_code, region: place.admin1,
    data: daily.time[day], strefa: timezone,
    warunki: code == null ? null : weatherDescriptions[code] ?? null,
    temperaturaMinC: daily.temperature_2m_min[day] ?? null,
    temperaturaMaxC: daily.temperature_2m_max[day] ?? null,
    prawdopodobienstwoOpadowProc: daily.precipitation_probability_max[day] ?? null,
  });
}

const holidaysResponse = z.array(z.object({
  date: z.iso.date(), name: z.string(), nationalHoliday: z.boolean(),
  subdivisionCodes: z.array(z.string()).nullable(), holidayTypes: z.array(z.string()),
}));

export async function getPublicHolidays(kraj: string, rok: number, abortSignal?: AbortSignal) {
  const response = await fetchData(new URL(`https://nagerholidays.com/api/v4/Holidays/${kraj}/${rok}`), holidaysResponse, abortSignal);
  if (!response.ok) return toolFailure(response.status === 400 || response.status === 404
    ? "Nager.Date nie ma danych dla tego kraju lub roku. Sprawdź kod kraju i rok."
    : "Nie udało się pobrać dni wolnych z Nager.Date. Spróbuj ponownie.");
  return toolResult({ kraj, rok, dniWolne: response.data.filter((day) => day.holidayTypes.includes("Public"))
    .map((day) => ({ data: day.date, nazwaAngielska: day.name, ogolnokrajowe: day.nationalHoliday,
      ...(!day.nationalHoliday && day.subdivisionCodes?.length && { regiony: day.subdivisionCodes }),
    })) });
}

const wikipediaResponse = z.object({ query: z.object({ pages: z.array(z.object({
  title: z.string(), ns: z.number(), pageid: z.int().positive().optional(),
  extract: z.string().optional(), missing: z.boolean().optional(),
  pageprops: z.object({ disambiguation: z.string().optional() }).optional(),
})) }) });

export async function getWikipediaArticle(haslo: string, abortSignal?: AbortSignal, sentences?: number) {
  const url = new URL("https://pl.wikipedia.org/w/api.php");
  url.search = new URLSearchParams({
    action: "query", prop: sentences ? "extracts|pageprops" : "extracts", exintro: "1", explaintext: "1", redirects: "1",
    ...(sentences ? { exsentences: String(sentences), ppprop: "disambiguation" } : { exchars: "500" }),
    titles: haslo, format: "json", formatversion: "2",
  }).toString();
  const response = await fetchData(url, wikipediaResponse, abortSignal, "LABA-Chat/0.1 (https://github.com/Bartekplt/moj-pierwszy-chat)");
  if (!response.ok) return toolFailure("Nie udało się pobrać hasła z polskiej Wikipedii. Spróbuj ponownie.");
  const page = response.data.query.pages[0];
  if (!page || page.missing || page.ns !== 0 || !page.pageid || page.pageprops?.disambiguation !== undefined) {
    return toolFailure("Nie znaleziono takiego artykułu w polskiej Wikipedii. Podaj inną nazwę hasła.");
  }
  const extract = page.extract?.trim();
  if (!extract) return toolFailure("Artykuł w polskiej Wikipedii nie zawiera krótkiego wstępu.");
  return toolResult({ tytul: page.title, streszczenie: extract, url: `https://pl.wikipedia.org/?curid=${page.pageid}` });
}
