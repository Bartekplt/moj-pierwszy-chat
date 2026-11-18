import ExcelJS, { type Cell, type Worksheet } from "exceljs";
import { SaxesParser } from "saxes";
import { fromBufferPromise } from "yauzl";
import { DOCUMENT_LIMIT } from "../documents.ts";
import { changeRange, sheetRange, XLSX_RESULT, type CellValue } from "../spreadsheets.ts";
import type { ChatDocument } from "./document-input.ts";
import { SpreadsheetError } from "./spreadsheet-error.ts";

async function inspectWorkbook(bytes: Buffer, signal?: AbortSignal) {
  const maxUncompressed = 15 * 1024 * 1024;
  const zip = await fromBufferPromise(bytes, { validateEntrySizes: true });
  const filenames = new Set<string>();
  let canEdit = true;
  let total = 0;
  let mergedCells = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      if (entry.isEncrypted() || filenames.has(entry.fileName) || filenames.size >= 300 ||
          total + entry.uncompressedSize > maxUncompressed) throw new SpreadsheetError("Nieprawidłowe archiwum XLSX");
      filenames.add(entry.fileName);
      if (/^xl\/(?:charts|pivot\w*|slicers|queryTables|externalLinks|embeddings)\/|^xl\/(?:vbaProject\.bin|connections\.xml)$/i.test(entry.fileName)) canEdit = false;
      if (!entry.fileName.endsWith("/")) {
        const parser = /^xl\/worksheets\/[^/]+\.xml$/i.test(entry.fileName) ? new SaxesParser({ xmlns: false }) : undefined;
        const decoder = parser && new TextDecoder("utf-8", { fatal: true });
        parser?.on("opentag", ({ name, attributes }) => {
          const tag = name.split(":").at(-1);
          if (tag === "sheetProtection") canEdit = false;
          if (tag !== "mergeCell") return;
          const bounds = sheetRange(attributes.ref ?? "", 10_000);
          if (!bounds) throw new Error("Nieprawidłowy zakres scalenia");
          mergedCells += bounds.width * bounds.height;
          if (mergedCells > 10_000) throw new Error("Za dużo scalonych komórek");
        });
        const stream = await zip.openReadStreamPromise(entry);
        for await (const chunk of stream) {
          signal?.throwIfAborted();
          total += chunk.length;
          if (total > maxUncompressed) throw new SpreadsheetError("Za duże archiwum XLSX");
          if (parser && decoder) parser.write(decoder.decode(chunk, { stream: true }));
        }
        if (parser && decoder) parser.write(decoder.decode()).close();
      }
    }
    if (!filenames.has("[Content_Types].xml") || !filenames.has("xl/workbook.xml")) throw new SpreadsheetError("Brak struktury XLSX");
    return canEdit;
  } finally {
    zip.close();
  }
}

function readCell(cell: Cell): unknown {
  const value = cell.value;
  if (value == null || typeof value === "number" || typeof value === "boolean") return value ?? null;
  if (typeof value === "string") return value.slice(0, 500);
  if (value instanceof Date) return value.toISOString();
  if (cell.formula) {
    const result = cell.result;
    return { formula: cell.formula.slice(0, 500), wartosc: typeof result === "string" ? result.slice(0, 500) : result ?? null };
  }
  return cell.text.slice(0, 500);
}

function selectSheet(workbook: ExcelJS.Workbook, karta: string) {
  return workbook.worksheets.find((sheet) => sheet.name === karta);
}

export function createWorkbookReader(document: ChatDocument | undefined) {
  let loaded: Promise<{ workbook: ExcelJS.Workbook; canEdit: boolean }> | undefined;

  async function open(signal?: AbortSignal) {
    if (!document) throw new SpreadsheetError("Dodaj XLSX przyciskiem „Dodaj dokument”.");
    loaded ??= (async () => {
      try {
        const canEdit = await inspectWorkbook(document.bytes, signal);
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(new Uint8Array(document.bytes).buffer);
        return { workbook, canEdit };
      } catch {
        signal?.throwIfAborted();
        throw new SpreadsheetError("Nie udało się otworzyć XLSX. Plik może być uszkodzony, zaszyfrowany lub zbyt złożony.");
      }
    })();
    return loaded;
  }

  return {
    async list(signal?: AbortSignal) {
      const { workbook } = await open(signal);
      return { plik: document!.name, karty: workbook.worksheets.slice(0, 50).map((sheet) => ({
        nazwa: sheet.name, wiersze: sheet.rowCount, kolumny: sheet.columnCount,
      })) };
    },
    async read(karta: string, zakres: string, signal?: AbortSignal) {
      const range = sheetRange(zakres, 150);
      if (!range) throw new SpreadsheetError("Podaj zakres A1 obejmujący maksymalnie 150 komórek, np. A1:F20.");
      const { workbook } = await open(signal);
      const sheet = selectSheet(workbook, karta);
      if (!sheet) throw new SpreadsheetError("Karta nie istnieje. Sprawdź listę kart.");
      const wiersze = Array.from({ length: range.height }, (_, row) => Array.from({ length: range.width }, (_, column) =>
        readCell(sheet.getCell(range.row + row, range.column + column))));
      return { plik: document!.name, karta, zakres, wiersze };
    },
    async edit(karta: string, zakres: string, wartosci: CellValue[][], signal?: AbortSignal) {
      const range = changeRange(zakres, wartosci);
      if (!range) throw new SpreadsheetError("Wartości muszą wypełniać wskazany zakres, maksymalnie 50 komórek.");
      const { canEdit } = await open(signal);
      if (!canEdit) throw new SpreadsheetError("Nie można zapisać kopii z chronionymi kartami lub elementami takimi jak wykresy i tabele przestawne.");
      // Każda kopia zaczyna od pliku użytkownika, więc równoległe wywołania się nie mieszają.
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(new Uint8Array(document!.bytes).buffer);
      const sheet = selectSheet(workbook, karta);
      if (!sheet) throw new SpreadsheetError("Karta nie istnieje. Sprawdź listę kart.");
      updateCells(sheet, range, wartosci);
      workbook.calcProperties.fullCalcOnLoad = true;
      const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
      if (bytes.length > DOCUMENT_LIMIT) throw new SpreadsheetError("Zmieniona kopia przekracza 2 MB.");
      return { typ: XLSX_RESULT, filename: "arkusz-kopia.xlsx", base64: bytes.toString("base64"), karta, zakres };
    },
  };
}

function updateCells(sheet: Worksheet, range: NonNullable<ReturnType<typeof changeRange>>, values: CellValue[][]) {
  for (const [row, entries] of values.entries()) {
    for (const [column, value] of entries.entries()) {
      const cell = sheet.getCell(range.row + row, range.column + column);
      if (cell.isMerged) throw new SpreadsheetError("Wskazany zakres zawiera scalenie. Wybierz zwykłe komórki.");
      cell.value = value === "" ? null : value;
    }
  }
}
