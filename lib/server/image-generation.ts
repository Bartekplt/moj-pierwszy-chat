import { generateImage, jsonSchema, tool } from "ai";
import { imageModelWithResponseMetadata } from "./image-model.ts";
import type { GeneratedImage } from "../images.ts";
import { classifyImageError, ImageGenerationError } from "./image-errors.ts";
import { toolTimeoutMs } from "./chat-task.ts";

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
  const timeout = AbortSignal.timeout(toolTimeoutMs);
  const startedAt = Date.now();
  try {
    const imageModel = imageModelWithResponseMetadata(apiKey);
    const result = await generateImage({
      model: imageModel.model, prompt, n: 1, maxRetries: 0,
      abortSignal: AbortSignal.any([signal, timeout]),
    });
    if (!result.image.mediaType.startsWith("image/")) throw new ImageGenerationError("format");
    return {
      url: `data:${result.image.mediaType};base64,${result.image.base64}`,
      mediaType: result.image.mediaType, modelId: imageModel.getModelId(),
    };
  } catch (error) {
    const failure = signal.aborted ? new ImageGenerationError("cancelled")
      : timeout.aborted ? new ImageGenerationError("timeout") : classifyImageError(error);
    // Bez treści opisu, klucza, obrazu i surowej odpowiedzi dostawcy.
    console.warn("image_generation_failed", {
      code: failure.code, status: failure.httpStatus, elapsedMs: Date.now() - startedAt,
    });
    throw failure;
  }
}

export function createImageTool(apiKey: string, signal: AbortSignal) {
  return tool({
    description: "Generuje jeden obraz na podstawie opisu (do 500 znaków). Użyj, gdy użytkownik prosi o stworzenie grafiki, ilustracji lub obrazu. Zachowaj opis użytkownika; nie rozbudowuj go ponad limit 500 znaków. Obraz automatycznie pojawi się w rozmowie. Nie kopiuj danych obrazu ani linku base64 do odpowiedzi.",
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
