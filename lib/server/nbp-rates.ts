import { z } from "zod";
import { fetchData } from "./fetch-public-data.ts";
import { toolFailure, toolResult } from "./tool-result.ts";

const quotedRate = z.object({ mid: z.number().positive(), effectiveDate: z.iso.date() });
const nbpResponse = z.object({ code: z.string(), rates: z.array(quotedRate) });
const nbpTables = z.array(z.object({
  effectiveDate: z.iso.date(),
  rates: z.array(z.object({ code: z.string(), mid: z.number().positive() })),
}));
const nbpCalendar = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" });

export const currencyInput = z.strictObject({
  waluta: z.string().trim().regex(/^[a-z]{3}$/i).toUpperCase().describe("Kod ISO 4217, np. EUR, USD lub GBP"),
  kwota: z.number().min(-1e12).max(1e12).optional().describe("Kwota do przeliczenia"),
  kierunek: z.enum(["naPLN", "zPLN"]).optional().describe("Domyślnie naPLN. Użyj zPLN, gdy kwota jest w złotych"),
});

function ratePeriod(daysAgo: number) {
  const doDnia = nbpCalendar.format(new Date());
  const start = new Date(`${doDnia}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - daysAgo);
  return { odDnia: start.toISOString().slice(0, 10), doDnia };
}

async function getPublishedRates(waluta: string, { odDnia, doDnia }: ReturnType<typeof ratePeriod>, signal?: AbortSignal, lastCount?: number) {
  const inPeriod = ({ effectiveDate }: z.infer<typeof quotedRate>) => effectiveDate >= odDnia && effectiveDate <= doDnia;
  async function lookup(table: "A" | "B") {
    const base = "https://api.nbp.pl/api/exchangerates/";
    const ratesPath = `rates/${table.toLowerCase()}/${waluta.toLowerCase()}/`;
    const range = `${odDnia}/${doDnia}/`;
    const response = await fetchData(new URL(`${ratesPath}${range}${lastCount ? "?format=json" : ""}`, base), nbpResponse, signal);
    if (!lastCount) return response;
    if (response.ok ? response.data.rates.some(inPeriod) : response.status !== 404) return response;

    const last = await fetchData(new URL(`${ratesPath}last/${lastCount}/`, base), nbpResponse, signal);
    if (last.ok && last.data.code === waluta && last.data.rates.some(inPeriod)) return last;

    // Zapytanie o jedną walutę potrafi zwrócić 404, mimo że NBP ma ją w pełnej tabeli.
    const tables = await fetchData(new URL(`tables/${table.toLowerCase()}/${range}?format=json`, base), nbpTables, signal);
    if (!tables.ok) return tables;
    const rates = tables.data.flatMap(({ effectiveDate, rates }) => {
      const quoted = rates.find(({ code }) => code === waluta);
      return quoted ? [{ effectiveDate, mid: quoted.mid }] : [];
    }).filter(inPeriod);
    return rates.length ? { ok: true as const, data: { code: waluta, rates } } : { ok: false as const, status: 404 };
  }
  let tabela: "A" | "B" = "A";
  let response = await lookup(tabela);
  if (!response.ok && response.status === 404) {
    tabela = "B";
    response = await lookup(tabela);
  }
  if (!response.ok) return toolFailure(response.status === 404 ?
    `NBP nie publikuje kursu dla waluty ${waluta} w sprawdzonym okresie. Sprawdź kod waluty.` :
    "Nie udało się pobrać kursu z NBP. Spróbuj ponownie.");
  if (response.data.code !== waluta) return toolFailure("NBP zwrócił kurs dla innej waluty. Spróbuj ponownie.");
  return { tabela, rates: response.data.rates.filter(inPeriod) };
}

export async function getMonthlyCurrencyRate(waluta: string, signal?: AbortSignal) {
  const days = 30;
  const period = ratePeriod(days - 1);
  if (waluta === "PLN") return toolResult({ waluta, kursPLN: 1, ...period, liczbaNotowan: null });
  const result = await getPublishedRates(waluta, period, signal, days);
  if ("blad" in result) return result;
  const ratesByDay = new Map(result.rates.map(({ effectiveDate, mid }) => [effectiveDate, mid]));
  if (!ratesByDay.size) return toolFailure(`NBP nie zwrócił notowań ${waluta} z ostatnich 30 dni.`);
  const total = [...ratesByDay.values()].reduce((sum, rate) => sum + rate, 0);
  return toolResult({ waluta, kursPLN: total / ratesByDay.size, ...period, liczbaNotowan: ratesByDay.size });
}

export async function getCurrencyRate({ waluta, kwota, kierunek = "naPLN" }: z.infer<typeof currencyInput>, abortSignal?: AbortSignal) {
  let kursPLN = 1;
  let dataKursu: string | null = null;
  let tabela: "A" | "B" | null = null;
  if (waluta !== "PLN") {
    // Tabela B ukazuje się raz na tydzień, a tabela A pomija dni wolne.
    const result = await getPublishedRates(waluta, ratePeriod(14), abortSignal);
    if ("blad" in result) return result;
    const rate = result.rates.sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
    if (!rate) return toolFailure(`NBP nie zwrócił aktualnego kursu ${waluta}. Spróbuj ponownie później.`);
    tabela = result.tabela;
    kursPLN = rate.mid;
    dataKursu = rate.effectiveDate;
  }
  if (kwota === undefined) return toolResult({ waluta, kursPLN, dataKursu, tabela });

  const walutaWyniku = kierunek === "zPLN" ? waluta : "PLN";
  const raw = kierunek === "zPLN" ? kwota / kursPLN : kwota * kursPLN;
  if (!Number.isFinite(raw)) return toolFailure("Kwota po przeliczeniu wykracza poza zakres obliczeń.");
  const precision = new Intl.NumberFormat("pl-PL", { style: "currency", currency: walutaWyniku })
    .resolvedOptions().maximumFractionDigits ?? 2;
  const rounded = new Intl.NumberFormat("en-US", { useGrouping: false, maximumFractionDigits: precision }).format(raw);
  return toolResult({
    waluta, kursPLN, dataKursu, tabela, kwota, walutaKwoty: kierunek === "zPLN" ? "PLN" : waluta,
    wynik: Number(rounded), walutaWyniku,
  });
}
