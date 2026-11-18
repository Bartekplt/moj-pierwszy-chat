import { tool } from "ai";
import { z } from "zod";
import { cellRows, GOOGLE_PREVIEW, rangeInput, sheetName, spreadsheetId, XLSX_RESULT } from "../spreadsheets.ts";
import type { ChatDocument } from "./document-input.ts";
import { openGoogleSheet, prepareGoogleWrite } from "./google-sheets.ts";
import { createWorkbookReader } from "./xlsx.ts";
import { SpreadsheetError } from "./spreadsheet-error.ts";

export function createSpreadsheetTool(request: Request, document: ChatDocument | undefined, googleIds: Set<string>) {
  const workbook = createWorkbookReader(document);
  return tool({
    description: "Czyta i edytuje arkusz. Dla XLSX używaj ostatniego załącznika, dla Google arkusza wskazanego linkiem użytkownika. " +
      "Operacja karty listuje karty, odczyt odczytuje komórki, a edycja XLSX zwraca kopię z nowymi wartościami. " +
      "Edycja Google tworzy podgląd, a zmianę zapisuje użytkownik osobnym przyciskiem.",
    inputSchema: z.object({
      zrodlo: z.enum(["xlsx", "google"]),
      operacja: z.enum(["karty", "odczyt", "edycja"]),
      id: spreadsheetId.describe("Identyfikator arkusza z wklejonego linku Google Sheets.").optional(),
      karta: sheetName.describe("Dokładna nazwa karty dla odczytu lub edycji.").optional(),
      zakres: rangeInput.describe("Zakres A1 bez nazwy karty, np. A1:D10. Do 150 komórek przy odczycie, do 50 przy edycji.").optional(),
      wartosci: cellRows.describe("Dla edycji: wiersze wartości do wpisania w całym zakresie.").optional(),
    }).strict(),
    execute: async ({ zrodlo, operacja, id, karta, zakres, wartosci }, { abortSignal }) => {
      const signal = abortSignal ? AbortSignal.any([request.signal, abortSignal]) : request.signal;
      if (zrodlo === "google" && (!id || !googleIds.has(id))) {
        return { blad: "Wklej link do arkusza Google Sheets w wiadomości." };
      }
      if (operacja !== "karty" && (!karta || !zakres)) return { blad: "Podaj kartę i zakres komórek." };
      if (operacja === "edycja" && !wartosci) return { blad: "Podaj wartości do wpisania." };
      try {
        if (zrodlo === "xlsx") {
          if (operacja === "karty") return await workbook.list(signal);
          if (operacja === "odczyt") return await workbook.read(karta!, zakres!, signal);
          return await workbook.edit(karta!, zakres!, wartosci!, signal);
        }
        if (operacja === "edycja") {
          return await prepareGoogleWrite(request, { id: id!, karta: karta!, zakres: zakres!, wartosci: wartosci! }, signal);
        }
        const sheet = openGoogleSheet(id!, signal);
        if (operacja === "karty") return await sheet.list();
        return { karta, zakres, wiersze: await sheet.values(karta!, zakres!) };
      } catch (error) {
        signal.throwIfAborted();
        return { blad: error instanceof SpreadsheetError
          ? error.message : "Nie udało się wykonać operacji na arkuszu." };
      }
    },
    toModelOutput: ({ output }) => {
      if ("base64" in output && output.typ === XLSX_RESULT) {
        return { type: "text", value: `Utworzono kopię XLSX. Zmieniono ${output.karta}, ${output.zakres}. Plik można pobrać w rozmowie.` };
      }
      if ("potwierdzenie" in output && output.typ === GOOGLE_PREVIEW) {
        return { type: "text", value: `Podgląd Google Sheets: ${output.nazwa}, karta ${output.karta}, zakres ${output.zakres}. Zmiany czekają na zatwierdzenie przyciskiem w czacie.` };
      }
      return { type: "text", value: JSON.stringify(output) };
    },
  });
}
