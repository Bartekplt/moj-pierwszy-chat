import type { FileUIPart } from "ai";
import { DOCUMENT_LIMIT, documentType, matchesDocumentType } from "../documents.ts";

export function decodeDocument(part: FileUIPart) {
  const name = part.filename;
  if (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name) || documentType(name) !== part.mediaType) return;
  const prefix = `data:${part.mediaType};base64,`;
  if (!part.url.startsWith(prefix) || part.url.length > prefix.length + Math.ceil(DOCUMENT_LIMIT / 3) * 4) return;
  const encoded = part.url.slice(prefix.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length <= DOCUMENT_LIMIT && bytes.toString("base64") === encoded &&
      matchesDocumentType(bytes, part.mediaType)) return { name, bytes };
}

export type ChatDocument = NonNullable<ReturnType<typeof decodeDocument>>;
