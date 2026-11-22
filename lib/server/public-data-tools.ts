import { tool } from "ai";
import { z } from "zod";
import { countryCode, findCity, getCityForecast, getPublicHolidays, getWikipediaArticle } from "./public-data.ts";
import { currencyInput, getCurrencyRate } from "./nbp-rates.ts";

export const pogoda = tool({
  description: "Pobiera dzienną prognozę pogody z Open-Meteo dla miasta: stan pogody, temperatury w °C i szansę opadów. " +
    "Użyj do pytań o pogodę dziś lub w konkretnym dniu. Przy niejasnej lokalizacji dopytaj o kraj lub region.",
  inputSchema: z.strictObject({
    miasto: z.string().trim().min(2).max(100).describe("Nazwa miasta, opcjonalnie z regionem po przecinku"),
    kraj: countryCode.optional().describe("Opcjonalny dwuliterowy kod kraju ISO, np. PL"),
    data: z.iso.date().optional().describe("Data lokalna YYYY-MM-DD. Brak oznacza dziś w mieście"),
  }),
  execute: async ({ miasto, kraj, data }, { abortSignal }) => {
    const location = await findCity(miasto, kraj, abortSignal);
    return "blad" in location ? location : getCityForecast(location.place, data, abortSignal);
  },
});

export const waluty = tool({
  description: "Zwraca ostatni opublikowany średni kurs NBP w PLN za jednostkę wskazanej waluty. " +
    "Bierze opcjonalną kwotę i przelicza z tej waluty na PLN lub odwrotnie. Podaj datę publikacji kursu.",
  inputSchema: currencyInput,
  execute: (input, { abortSignal }) => getCurrencyRate(input, abortSignal),
});

export const swieta = tool({
  description: "Pobiera dni ustawowo wolne od pracy z Nager.Date dla podanego kraju i roku. " +
    "Odróżnij święta krajowe od regionalnych. W polskiej odpowiedzi przetłumacz angielskie nazwy świąt.",
  inputSchema: z.strictObject({
    kraj: countryCode.describe("Dwuliterowy kod kraju ISO, np. PL lub DE"),
    rok: z.int().min(1900).max(2100).describe("Rok z przedziału 1900–2100"),
  }),
  execute: ({ kraj, rok }, { abortSignal }) => getPublicHolidays(kraj, rok, abortSignal),
});

export const wikipedia = tool({
  description: "Pobiera krótki wstęp i link do artykułu polskiej Wikipedii po nazwie hasła. " +
    "Użyj do krótkich objaśnień encyklopedycznych. Streść własnymi słowami i wskaż artykuł ze źródeł.",
  inputSchema: z.strictObject({
    haslo: z.string().trim().min(1).max(200).regex(/^[^|\x00-\x1f\x7f]+$/).describe("Tytuł jednego hasła w języku polskim"),
  }),
  execute: ({ haslo }, { abortSignal }) => getWikipediaArticle(haslo, abortSignal),
});
