import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { abortable } from "./chat-task.ts";
import type { TravelCards } from "./travel-dashboard.ts";

type CityIndex = 0 | 1;
type City = { destination: { city: string }; cards: TravelCards };
type Fact = { cityIndex: CityIndex; text: string };
export type TravelRecommendation = { cityIndex: CityIndex | null; reasons: string[] };

function nationalWarning({ msz }: TravelCards) {
  if (!("warnings" in msz)) return null;
  const levels = msz.warnings.flatMap(({ national, level }) => {
    const match = national && /^Poziom ([1-4])\b/i.exec(level);
    return match ? [{ number: Number(match[1]), label: level }] : [];
  });
  return levels.toSorted((a, b) => b.number - a.number)[0] ?? null;
}

export async function recommendTravelCity(cities: [City, City], date: string, signal: AbortSignal): Promise<TravelRecommendation> {
  const [first, second] = cities;
  const [firstWarning, secondWarning] = cities.map(({ cards }) => nationalWarning(cards));
  const firstSevere = (firstWarning?.number ?? 0) >= 3;
  const secondSevere = (secondWarning?.number ?? 0) >= 3;
  if ((firstSevere || secondSevere) && (!firstWarning || !secondWarning || (firstSevere && secondSevere))) {
    return { cityIndex: null, reasons: ["Ostrzeżenia MSZ lub brak porównywalnych informacji o bezpieczeństwie nie pozwalają polecić jednego z miast."] };
  }

  const facts: Fact[] = [];
  if (firstWarning && secondWarning && firstWarning.number !== secondWarning.number) {
    facts.push({ cityIndex: firstWarning.number < secondWarning.number ? 0 : 1,
      text: `Ogólnokrajowe ostrzeżenia MSZ: ${first.destination.city} — ${firstWarning.label}, ${second.destination.city} — ${secondWarning.label}.` });
  }

  const rain = (cards: TravelCards) => "prawdopodobienstwoOpadowProc" in cards.weather ? cards.weather.prawdopodobienstwoOpadowProc : null;
  const firstRain = rain(first.cards);
  const secondRain = rain(second.cards);
  if (firstRain !== null && secondRain !== null && firstRain !== secondRain) {
    facts.push({ cityIndex: firstRain < secondRain ? 0 : 1,
      text: `Prognozowana szansa opadów: ${first.destination.city} — ${firstRain}%, ${second.destination.city} — ${secondRain}%.` });
  }

  const holiday = ({ holidays }: TravelCards) => "dniWolne" in holidays ? holidays.dniWolne.some(({ data }) => data === date) : null;
  const firstHoliday = holiday(first.cards);
  const secondHoliday = holiday(second.cards);
  if (firstHoliday !== null && secondHoliday !== null && firstHoliday !== secondHoliday) {
    facts.push({ cityIndex: firstHoliday ? 1 : 0,
      text: `W dniu podróży Nager.Date wskazuje dzień ustawowo wolny dla miasta ${cities[firstHoliday ? 0 : 1].destination.city}. W drugim kraju na ten dzień nie ma takiego wpisu.` });
  }

  const offset = ({ time }: TravelCards) => "roznicaMin" in time ? Math.abs(time.roznicaMin) : null;
  const firstOffset = offset(first.cards);
  const secondOffset = offset(second.cards);
  if (firstOffset !== null && secondOffset !== null && firstOffset !== secondOffset) {
    facts.push({ cityIndex: firstOffset < secondOffset ? 0 : 1,
      text: `Bieżąca różnica czasu względem Polski jest mniejsza dla miasta ${cities[firstOffset < secondOffset ? 0 : 1].destination.city} (${Math.min(firstOffset, secondOffset)} min wobec ${Math.max(firstOffset, secondOffset)} min).` });
  }

  if (!facts.length) return { cityIndex: null, reasons: ["Dostępne dane nie wykazały różnicy, na której można oprzeć rekomendację."] };

  const eligible = firstSevere || secondSevere ? facts.filter(({ cityIndex }) => cityIndex === (firstSevere ? 1 : 0)) : facts;
  const fallback = eligible.filter(({ cityIndex }) => cityIndex === eligible[0].cityIndex).slice(0, 2);
  let selection = fallback;
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim();
  if (apiKey && model && !firstSevere && !secondSevere) {
    try {
      const agentSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
      const { text, finishReason } = await abortable(agentSignal, () => generateText({
        model: createOpenRouter({ apiKey }).chat(model),
        instructions: "Wybierz jedno miasto na krótki wyjazd na podstawie poniższych faktów. " +
          "Uwzględnij najpierw ostrzeżenia MSZ, potem szansę opadów, dzień wolny i różnicę czasu. " +
          "Zwróć wyłącznie numer jednego lub dwóch faktów przemawiających za tym samym miastem, np. 1,4.",
        prompt: JSON.stringify(eligible.map(({ cityIndex, text }, index) => ({ id: index + 1, przemawiaZa: cities[cityIndex].destination.city, fakt: text }))),
        maxOutputTokens: 512, maxRetries: 0, abortSignal: agentSignal,
      }));
      if (finishReason === "stop" && /^\d+(?:\s*,\s*\d+)?$/.test(text.trim())) {
        const selected = [...new Set(text.trim().split(",").map(Number))].map((id) => eligible[id - 1]);
        if (selected.every((fact) => fact && fact.cityIndex === selected[0].cityIndex)) selection = selected;
      }
    } catch {
      signal.throwIfAborted();
    }
  }
  return { cityIndex: selection[0].cityIndex, reasons: selection.map(({ text }) => text) };
}
