import type { FileUIPart } from "ai";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "../images.ts";

export function isValidPhoto(part: FileUIPart) {
  if (!IMAGE_TYPES.includes(part.mediaType) || part.url.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) return false;
  const prefix = `data:${part.mediaType};base64,`;
  if (!part.url.startsWith(prefix)) return false;
  const encoded = part.url.slice(prefix.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return false;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== encoded) return false;
  if (part.mediaType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (part.mediaType === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}
