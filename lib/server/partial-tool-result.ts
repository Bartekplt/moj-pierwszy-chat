import type { ChatToolName } from "../chat.ts";

function displayText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function partialToolResult(tool: ChatToolName, output: unknown): string | undefined {
  if (!output || typeof output !== "object") return;
  const result = output as Record<string, unknown>;
  const error = displayText(result.blad);
  if (error) return error;

  switch (tool) {
    case "aktualnyCzas":
    case "czas":
      return `${result.data}, ${result.godzina} (${result.strefa})`;
    case "kalkulator":
      return `Wynik obliczenia: ${result.wynik}.`;
    case "pogoda": {
      const temperatures = [result.temperaturaMinC, result.temperaturaMaxC].filter((value) => typeof value === "number");
      const temperature = temperatures.length ? `${temperatures.join("–")} °C` : "";
      const precipitation = typeof result.prawdopodobienstwoOpadowProc === "number"
        ? `szansa opadów ${result.prawdopodobienstwoOpadowProc}%` : "";
      const weather = [displayText(result.warunki), temperature, precipitation].filter(Boolean).join(", ");
      return `${result.miasto}, ${result.data}: ${weather || "brak szczegółów prognozy"}.`;
    }
    case "waluty":
      return typeof result.wynik === "number"
        ? `${result.kwota} ${result.walutaKwoty} = ${result.wynik} ${result.walutaWyniku}${result.dataKursu ? ` (kurs NBP z ${result.dataKursu})` : ""}.`
        : `1 ${result.waluta} = ${result.kursPLN} PLN${result.dataKursu ? ` (kurs NBP z ${result.dataKursu})` : ""}.`;
    case "swieta":
      if (Array.isArray(result.dniWolne)) {
        const dates = result.dniWolne.slice(0, 3).map(({ data, nazwaAngielska }) => `${data} (${nazwaAngielska})`);
        return `${result.kraj}, ${result.rok}: ${result.dniWolne.length} wpisów o dniach wolnych${dates.length ? `, m.in. ${dates.join(", ")}` : ""}.`;
      }
      break;
    case "wikipedia":
      return `${result.tytul}: ${displayText(result.streszczenie)}`;
    case "oswiadczeniaZdrowotneUE":
      return `Rejestr UE: ${result.liczbaDopasowan} pasujących wpisów. Linki są w źródłach odpowiedzi.`;
    case "notatki":
      if (result.zapisano === true) return "Zapisano notatkę.";
      if (Array.isArray(result.notatki)) {
        const examples = result.notatki.slice(0, 2).map((note) => displayText(note.tresc));
        return `Notatki w sesji: ${result.notatki.length}${examples.length ? `, m.in. ${examples.join(" / ")}` : ""}.`;
      }
      break;
    case "diagnostyka":
      return `Model: ${result.model}. Limit: ${result.limitKrokow} kroków.`;
    case "czytajPdf":
      if (result.uwaga) return displayText(result.uwaga);
      if (Array.isArray(result.strony)) return `Odczytano strony PDF: ${result.strony.map((page) => page.numer).join(", ")}.`;
      break;
    case "arkusze":
      if (Array.isArray(result.wiersze)) return `Odczytano ${result.wiersze.length} wierszy z zakresu ${result.zakres}.`;
      if (Array.isArray(result.karty)) return `Karty arkusza: ${result.karty.join(", ")}.`;
      return "Wynik operacji na arkuszu jest widoczny w rozmowie.";
    case "generujObraz":
      return "Wygenerowano obraz widoczny w rozmowie.";
  }
}
