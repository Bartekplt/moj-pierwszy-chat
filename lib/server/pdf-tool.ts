import { tool } from "ai";
import { getDocumentProxy } from "unpdf";
import { z } from "zod";
import type { ChatDocument } from "./document-input.ts";

const maxPagesPerRead = 8;
const maxTextPerRead = 20_000;

export function createPdfTool(document: ChatDocument | undefined) {
  return tool({
    description: "Odczytuje tekst z ostatniego PDF-a załączonego przez użytkownika. " +
      "Użyj do pytań o dokument. Bez podanego zakresu odczytuje pierwsze strony. " +
      "Jeśli odpowiedzi nie ma w tym zakresie, odczytaj kolejne strony. Cytuj numer strony.",
    inputSchema: z.object({
      odStrony: z.number().int().min(1).max(10_000).describe("Pierwsza strona, domyślnie 1.").optional(),
      liczbaStron: z.number().int().min(1).max(maxPagesPerRead).describe("Liczba stron, domyślnie 8.").optional(),
    }).strict(),
    execute: async ({ odStrony = 1, liczbaStron = maxPagesPerRead }, { abortSignal }) => {
      if (!document) return { blad: "Dodaj PDF do rozmowy przyciskiem „Dodaj dokument”." };
      let pdf;
      try {
        abortSignal?.throwIfAborted();
        pdf = await getDocumentProxy(new Uint8Array(document.bytes), {
          maxImageSize: 16_777_216, stopAtErrors: true,
        });
        const liczbaWszystkichStron = pdf.numPages;
        if (odStrony > liczbaWszystkichStron) {
          return { plik: document.name, liczbaWszystkichStron, blad: "Wskazana strona nie istnieje." };
        }
        const strony = [];
        let remaining = maxTextPerRead;
        let nastepnaStrona: number | null = null;
        const end = Math.min(odStrony + liczbaStron - 1, liczbaWszystkichStron);
        for (let numer = odStrony; numer <= end; numer++) {
          abortSignal?.throwIfAborted();
          const page = await pdf.getPage(numer);
          const { items } = await page.getTextContent();
          const text = items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
          page.cleanup();
          if (text.length > remaining && strony.length > 0) {
            nastepnaStrona = numer;
            break;
          }
          strony.push({ numer, tekst: text.slice(0, remaining), skrocona: text.length > remaining });
          remaining -= Math.min(text.length, remaining);
        }
        nastepnaStrona ??= end < liczbaWszystkichStron ? end + 1 : null;
        return {
          plik: document.name, liczbaWszystkichStron, strony, nastepnaStrona,
          ...(!strony.some((item) => item.tekst) && {
            uwaga: "Brak warstwy tekstowej na odczytanych stronach. Skan wymaga OCR.",
          }),
        };
      } catch (error) {
        abortSignal?.throwIfAborted();
        return { blad: error instanceof Error && error.name === "PasswordException"
          ? "PDF jest zabezpieczony hasłem. Załącz odblokowaną kopię."
          : "Nie udało się odczytać tego PDF-a. Sprawdź, czy plik otwiera się w przeglądarce." };
      } finally {
        await pdf?.loadingTask.destroy().catch(() => {});
      }
    },
  });
}
