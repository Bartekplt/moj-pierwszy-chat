import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { imageHttpError, ImageGenerationError } from "./image-errors.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

// Adapter dla jednego obrazu tekst → obraz. /images nie podaje modelu w odpowiedzi;
// multimodalne /chat/completions zwraca obraz razem z faktycznie użytym modelem.
// generateImage i imageModel nadal odpowiadają za wywołanie i dekodowanie obrazu.
export function imageModelWithResponseMetadata(apiKey: string) {
  let modelId: string | null = null;
  const openrouter = createOpenRouter({ apiKey, fetch: async (_url, options) => {
    if (typeof options?.body !== "string") throw new Error("Brak opisu obrazu");
    const input = record(JSON.parse(options.body));
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      ...options,
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: input.prompt }],
        modalities: ["image", "text"],
        stream: false,
      }),
    });
    if (!response.ok) return response;
    const payload = record(await response.json());
    if (payload.error) {
      const code = record(payload.error).code;
      throw imageHttpError(typeof code === "number" ? code : undefined);
    }
    if (typeof payload.model === "string" && payload.model.trim()) modelId = payload.model;
    const choice = Array.isArray(payload.choices) ? record(payload.choices[0]) : {};
    const message = record(choice.message);
    if (message.refusal || choice.finish_reason === "content_filter") throw new ImageGenerationError("refused");
    const images = Array.isArray(message.images) ? message.images : [];
    if (!images.length) throw new ImageGenerationError("empty");
    const data = images.map((image: unknown) => {
      const url = record(record(image).image_url).url;
      if (typeof url !== "string") throw new ImageGenerationError("format");
      const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(url);
      if (!match) throw new ImageGenerationError("format");
      return { b64_json: match[1] };
    });
    const usage = record(payload.usage);
    return Response.json({
      data,
      ...(typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number" &&
        typeof usage.total_tokens === "number" ? { usage } : {}),
    });
  } });
  return {
    model: openrouter.imageModel("google/gemini-nano-banana-2.1"),
    getModelId: () => modelId,
  };
}
