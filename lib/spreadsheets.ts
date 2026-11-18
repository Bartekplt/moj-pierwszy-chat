import { z } from "zod";

export const XLSX_RESULT = "xlsx";
export const GOOGLE_PREVIEW = "google-propozycja";

export const sheetName = z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/);
export const spreadsheetId = z.string().min(10).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const rangeInput = z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/);
export const cellValue = z.union([z.string().max(500), z.number(), z.boolean()]);
export const cellRows = z.array(z.array(cellValue).min(1).max(20)).min(1).max(30);

function cellCoordinates(address: string) {
  const columnName = address.match(/^[A-Z]+/)![0];
  const column = Array.from(columnName).reduce((number, char) => number * 26 + char.charCodeAt(0) - 64, 0);
  return { column, row: Number(address.slice(columnName.length)) };
}

export function sheetRange(address: string, limit: number) {
  if (!rangeInput.safeParse(address).success) return;
  const [first, last = first] = address.split(":");
  const start = cellCoordinates(first);
  const end = cellCoordinates(last);
  const height = end.row - start.row + 1;
  const width = end.column - start.column + 1;
  if (height < 1 || width < 1 || height * width > limit || end.column > 16384 || end.row > 1048576) return;
  return { ...start, height, width };
}

export function cellAddress(row: number, column: number) {
  let name = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + (n - 1) % 26) + name;
  }
  return name + row;
}

export const sheetChange = z.object({
  id: spreadsheetId, karta: sheetName, zakres: rangeInput, wartosci: cellRows,
}).strict();

export const sheetPreview = sheetChange.extend({
  typ: z.literal(GOOGLE_PREVIEW),
  nazwa: z.string().max(200),
  przed: z.array(z.array(cellValue.nullable()).max(20)).max(30),
  potwierdzenie: z.string().max(150_000),
});

export type SheetChange = z.infer<typeof sheetChange>;
export type SheetPreview = z.infer<typeof sheetPreview>;
export type CellValue = z.infer<typeof cellValue>;

export function changeRange(zakres: string, wartosci: CellValue[][]) {
  const dimensions = sheetRange(zakres, 50);
  return dimensions && wartosci.length === dimensions.height &&
    wartosci.every((row) => row.length === dimensions.width) ? dimensions : undefined;
}

export function googleIds(texts: string[]) {
  const ids = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{10,128})(?![A-Za-z0-9_-])/g)) {
      ids.add(match[1]);
    }
  }
  return ids;
}
