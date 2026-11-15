import { jsonSchema, tool } from "ai";

export function getCurrentTime(now = new Date()) {
  const timeZone = "Europe/Warsaw";
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
  execute: async () => getCurrentTime(),
});
