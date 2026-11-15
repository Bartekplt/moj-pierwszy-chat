export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const IMAGE_INPUT_ERROR = "Wybierz zdjęcie JPG, PNG lub WebP o rozmiarze do 4 MB.";

export type GeneratedImage = { url: string; mediaType: string; modelId: string | null };

export function isGeneratedImage(value: unknown): value is GeneratedImage {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.url === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(item.url) &&
    typeof item.mediaType === "string" && IMAGE_TYPES.includes(item.mediaType) &&
    (item.modelId === null || typeof item.modelId === "string");
}

export function imageFailureToShow(parts: UIMessage["parts"], index: number, inProgress: boolean): string | null {
  const part = parts[index];
  if (!part || inProgress ||
    !(part.type === "tool-generujObraz" || (part.type === "dynamic-tool" && part.toolName === "generujObraz")) ||
    part.state !== "output-error") return null;
  const recovered = parts.slice(index + 1).some((next) =>
    (next.type === "tool-generujObraz" || (next.type === "dynamic-tool" && next.toolName === "generujObraz")) &&
    next.state === "output-available" && isGeneratedImage(next.output),
  );
  return recovered ? null : publicImageError(part.errorText);
}

export const IMAGE_PROMPTS = [
  { label: "Powitanie w Studio Nova", prompt: "Przyjazna grafika powitalna dla klientów Studio Nova: jasne biurko, laptop i roślina, spokojne kolory, minimalistyczna ilustracja, bez napisów." },
  { label: "Konsultacja online", prompt: "Ilustracja konsultacji online w Studio Nova: dwie osoby rozmawiają przez wideopołączenie na laptopie, ciepła i profesjonalna atmosfera, jasne tło, bez napisów." },
  { label: "Podziękowanie dla klienta", prompt: "Elegancka grafika z podziękowaniem dla klienta Studio Nova: otwarta koperta i delikatny motyw roślinny, ciepłe pastelowe kolory, dużo wolnej przestrzeni, bez napisów." },
] as const;

export function photoSelectionError(file: { name: string; type: string; size: number }) {
  if (!IMAGE_TYPES.includes(file.type) || !/\.(jpe?g|png|webp)$/i.test(file.name)) {
    return "Nieobsługiwany format zdjęcia. Wybierz plik JPG, PNG lub WebP.";
  }
  if (file.size > MAX_IMAGE_BYTES) return "Zdjęcie jest za duże. Maksymalny rozmiar to 4 MB.";
  if (!file.size) return "Wybrany plik jest pusty. Wybierz inne zdjęcie.";
  return null;
}

export function matchesImageType(bytes: Uint8Array, mediaType: string) {
  if (mediaType === "image/png") {
    return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  }
  if (mediaType === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mediaType === "image/webp") {
    return [82, 73, 70, 70].every((value, index) => bytes[index] === value) &&
      [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value);
  }
  return false;
}
import type { UIMessage } from "ai";
import { publicImageError } from "./image-errors.ts";

