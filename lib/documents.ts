export const PDF_TYPE = "application/pdf";
export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const DOCUMENT_LIMIT = 2 * 1024 * 1024;
export const DOCUMENT_TYPES = [PDF_TYPE, XLSX_TYPE];
export const DOCUMENT_INPUT_ERROR = "Wybierz poprawny PDF lub XLSX o rozmiarze do 2 MB.";
export const DOCUMENT_REQUEST_ERROR =
  "Rozmowa z załącznikami jest za duża. Otwórz nową kartę czatu i wyślij dokument z pytaniem.";

export function documentType(filename: string) {
  if (/\.pdf$/i.test(filename)) return PDF_TYPE;
  if (/\.xlsx$/i.test(filename)) return XLSX_TYPE;
}

export function matchesDocumentType(bytes: Uint8Array, mediaType: string) {
  if (mediaType === PDF_TYPE) return [37, 80, 68, 70, 45].every((value, i) => bytes[i] === value);
  return mediaType === XLSX_TYPE && [80, 75, 3, 4].every((value, i) => bytes[i] === value);
}
