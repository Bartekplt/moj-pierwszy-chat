import { jsonSchema, tool } from "ai";
import { z } from "zod";
import { toolFailure, toolResult } from "./tool-result.ts";

export function getCurrentTime(now = new Date(), timeZone = "Europe/Warsaw") {
  return {
    data: now.toLocaleDateString("pl-PL", { timeZone }),
    dzienTygodnia: now.toLocaleDateString("pl-PL", { timeZone, weekday: "long" }),
    godzina: now.toLocaleTimeString("pl-PL", { timeZone, hourCycle: "h23" }),
    strefa: timeZone,
  };
}

export const aktualnyCzas = tool({
  description: "Zwraca aktualną datę, dzień tygodnia i godzinę w strefie Europe/Warsaw. " +
    "Użyj przed odpowiedzią na pytania o bieżący czas oraz określenia względne: " +
    "dziś, jutro, wczoraj, za ile dni. Na podstawie wyniku ustal datę odniesienia " +
    "i oblicz żądaną datę lub liczbę dni. Narzędzie nie wymaga argumentów.",
  inputSchema: jsonSchema<Record<string, never>>({
    type: "object", properties: {}, additionalProperties: false,
  }, {
    validate: (value) => value !== null && typeof value === "object" &&
      !Array.isArray(value) && Object.keys(value).length === 0
      ? { success: true, value: {} }
      : { success: false, error: new Error("aktualnyCzas nie przyjmuje argumentów.") },
  }),
  execute: async () => {
    const now = new Date();
    return toolResult(getCurrentTime(now), now);
  },
});

export const czas = tool({
  description: "Zwraca bieżącą datę, dzień tygodnia i godzinę w wybranej strefie IANA. " +
    "Użyj, gdy użytkownik pyta o czas poza Polską lub wskazuje konkretną strefę. Bez strefy zwraca czas w Polsce.",
  inputSchema: z.strictObject({
    strefa: z.string().trim().max(100).regex(/^[a-z][a-z0-9_+/-]*$/i).optional()
      .describe("Strefa IANA, np. Asia/Tokyo, Europe/Warsaw lub UTC"),
  }),
  execute: async ({ strefa }) => {
    const now = new Date();
    try {
      return toolResult(getCurrentTime(now, strefa), now);
    } catch {
      return toolFailure("Nieznana strefa czasowa. Użyj nazwy IANA, np. Europe/Warsaw.");
    }
  },
});

export const kalkulator = tool({
  description: "Wykonuje dodawanie, odejmowanie, mnożenie lub dzielenie dwóch liczb. " +
    "Użyj do obliczeń arytmetycznych. Liczby przekaż osobno, zgodnie z kolejnością działania.",
  inputSchema: z.strictObject({
    operacja: z.enum(["dodaj", "odejmij", "pomnoz", "podziel"]),
    a: z.number().describe("Pierwsza liczba"),
    b: z.number().describe("Druga liczba"),
  }),
  execute: async ({ operacja, a, b }) => {
    let wynik: number;
    switch (operacja) {
      case "dodaj": wynik = a + b; break;
      case "odejmij": wynik = a - b; break;
      case "pomnoz": wynik = a * b; break;
      case "podziel":
        if (b === 0) return toolFailure("Nie można dzielić przez zero.");
        wynik = a / b;
        break;
    }
    if (!Number.isFinite(wynik)) return toolFailure("Wynik wykracza poza zakres kalkulatora.");
    return toolResult({ wynik });
  },
});

export function createDiagnosticsTool(model: string, getToolNames: () => string[], limitKrokow: number) {
  return tool({
    description: "Pokazuje nazwę modelu rozmowy, dostępne narzędzia, limit kroków i status wymaganych zmiennych. " +
      "Użyj, gdy użytkownik pyta o możliwości agenta lub konfigurację. Status zmiennych podawaj wyłącznie jako tak lub nie.",
    inputSchema: z.strictObject({}),
    execute: async () => toolResult({
      model, narzedzia: getToolNames(), limitKrokow,
      zmienneUstawione: {
        CHAT_PASSWORD: Boolean(process.env.CHAT_PASSWORD?.trim()),
        SESSION_SECRET: Boolean(process.env.SESSION_SECRET),
        OPENROUTER_API_KEY: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
        OPENROUTER_MODEL: Boolean(process.env.OPENROUTER_MODEL?.trim()),
      },
    }),
  });
}
