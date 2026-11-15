import { generateImage, jsonSchema, tool } from "ai";
import { imageModelWithResponseMetadata } from "./image-model.ts";
import type { GeneratedImage } from "../images.ts";

export const imageGenerationError = "Nie udało się wygenerować obrazu. Model Nano Banana 2.1 może być chwilowo niedostępny. Spróbuj ponownie później lub sprawdź dostęp i środki w OpenRouter.";

export function validateImagePrompt(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 && "prompt" in value && typeof value.prompt === "string" &&
    value.prompt.trim() && Array.from(value.prompt).length <= 500) {
    return { success: true as const, value: { prompt: value.prompt.trim() } };
  }
  return { success: false as const, error: new Error("Wpisz opis obrazu: od 1 do 500 znaków.") };
}

export async function generatePicture({ apiKey, prompt, signal }: {
  apiKey: string; prompt: string; signal: AbortSignal;
}): Promise<GeneratedImage> {
  try {
    const imageModel = imageModelWithResponseMetadata(apiKey);
    const result = await generateImage({
      model: imageModel.model, prompt, n: 1, maxRetries: 0,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(110_000)]),
    });
    if (!result.image.mediaType.startsWith("image/")) throw new Error("Brak obrazu");
    return {
      url: `data:${result.image.mediaType};base64,${result.image.base64}`,
      mediaType: result.image.mediaType, modelId: imageModel.getModelId(),
    };
  } catch {
    throw new Error(imageGenerationError);
  }
}

export function createImageTool(apiKey: string, signal: AbortSignal) {
  return tool({
    description: "Generuje jeden obraz na podstawie opisu (do 500 znaków). Użyj, gdy użytkownik prosi o stworzenie grafiki, ilustracji lub obrazu. Obraz automatycznie pojawi się w rozmowie. Nie kopiuj danych obrazu ani linku base64 do odpowiedzi.",
    inputSchema: jsonSchema<{ prompt: string }>({
      type: "object", properties: { prompt: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["prompt"], additionalProperties: false,
    }, { validate: validateImagePrompt }),
    execute: async ({ prompt }, { abortSignal }) => generatePicture({
      apiKey, prompt, signal: abortSignal ? AbortSignal.any([signal, abortSignal]) : signal,
    }),
    toModelOutput: () => ({ type: "text", value: "obraz wygenerowany" }),
  });
}
