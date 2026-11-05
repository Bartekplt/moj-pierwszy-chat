import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  APICallError, generateText, jsonSchema, NoObjectGeneratedError,
  NoOutputGeneratedError, Output,
} from "ai";
import { validateAnalysis, type Analysis } from "../analysis.ts";
import { studioNovaContext } from "./studio-nova.ts";

export const analysisSchema = jsonSchema<Analysis>({
  type: "object",
  properties: {
    category: { type: "string", enum: ["sales", "support", "billing", "unknown"] },
    priority: { type: "string", enum: ["normal", "high"] },
    draft: { type: "string" },
    needs_review: { type: "boolean" },
  },
  required: ["category", "priority", "draft", "needs_review"],
  additionalProperties: false,
}, { validate: validateAnalysis });

const instructions = `${studioNovaContext}

Analizujesz jedną wiadomość klienta. Zwróć wynik zgodny z podanym schematem.
category: sales = oferta i cena; support = problem techniczny;
billing = płatność lub zwrot; unknown = brak rozpoznanej sprawy.
priority: high wyłącznie przy blokadzie opłaconego spotkania zaczynającego się
w ciągu godziny. Wszystkie te warunki muszą wynikać z wiadomości.
W pozostałych przypadkach priority = normal. Nie zakładaj opłacenia ani bliskiego terminu.
needs_review = true przy braku danych lub konieczności decyzji pracownika.
draft: krótki, uprzejmy szkic odpowiedzi po polsku. Każdy wynik jest wyłącznie
szkicem, także gdy needs_review = false. Nie wykonujesz żadnych działań.
Jeśli sprawa jest niejasna, poproś o doprecyzowanie i ustaw needs_review = true.

Przykłady (wzorce, nie historia bieżącej rozmowy):
Klient: Proszę o ofertę dla 8 osób.
Wynik: {"category":"sales","priority":"normal","draft":"Dziękuję za wiadomość. Czy chodzi o osiem indywidualnych konsultacji, czy o spotkanie grupowe? Po doprecyzowaniu przekażemy sprawę pracownikowi.","needs_review":true}
Klient: Nie mogę się zalogować.
Wynik: {"category":"support","priority":"normal","draft":"Napisz proszę, jaki komunikat pojawia się podczas logowania.","needs_review":true}`;

const errors = {
  unsupported: [503, "Ustawiony OPENROUTER_MODEL nie ma potwierdzonej obsługi structured output (json_schema). Wybierz w konfiguracji OpenRouter model i endpoint obsługujący structured_outputs. Nie zmieniono modelu; ewentualną zmianę ceny uzgodnij przed zmianą konfiguracji. Zwykły czat pozostaje dostępny."],
  capabilities: [503, "Nie udało się sprawdzić obsługi structured output w katalogu OpenRouter. Analiza nie została uruchomiona. Spróbuj ponownie później."],
  refused: [422, "Model odmówił analizy wiadomości. Nie utworzono wyniku ani szkicu."],
  interrupted: [502, "Odpowiedź została przerwana lub nie została ukończona. Nie pokazano częściowego wyniku. Spróbuj ponownie."],
  invalid: [502, "Model nie zwrócił poprawnej analizy zgodnej ze schematem. Nie utworzono wyniku zastępczego. Spróbuj ponownie."],
  provider: [502, "Nie udało się uzyskać analizy od OpenRouter. Sprawdź klucz, środki i dostępność dostawcy, a następnie spróbuj ponownie."],
  configuration: [503, "OpenRouter odrzucił konfigurację analizy. Sprawdź OPENROUTER_MODEL oraz dostępność endpointu obsługującego json_schema i strict z require_parameters=true. Model nie został zmieniony; zwykły czat pozostaje dostępny."],
  cancelled: [499, "Analiza została anulowana. Nie utworzono wyniku."],
} as const;

export class AnalysisError extends Error {
  readonly code: keyof typeof errors;
  readonly status: number;

  constructor(code: keyof typeof errors) {
    super(errors[code][1]);
    this.code = code;
    this.status = errors[code][0];
  }
}

function checkFinishReason(reason: string) {
  if (reason === "content-filter") throw new AnalysisError("refused");
  if (reason !== "stop") throw new AnalysisError("interrupted");
}

async function checkModelSupport(model: string, signal: AbortSignal) {
  // Publiczne metadane, bez klucza i bez wywołania modelu. Sprawdzane przy analizie,
  // bo obsługa parametrów może się zmieniać. Bez automatycznej zmiany modelu.
  let body;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), cache: "no-store",
    });
    if (!response.ok) throw new Error("Katalog niedostępny");
    body = await response.json();
    if (!Array.isArray(body?.data)) throw new Error("Nieprawidłowy katalog");
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new AnalysisError("capabilities");
  }
  const entry = body.data.find((item: { id?: unknown } | null) => item?.id === model);
  if (!Array.isArray(entry?.supported_parameters) ||
      !entry.supported_parameters.includes("structured_outputs")) {
    throw new AnalysisError("unsupported");
  }
}

function hasRefusal(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("choices" in body) || !Array.isArray(body.choices)) return false;
  return body.choices.some((choice) => choice?.message?.refusal || choice?.finish_reason === "content_filter");
}

export async function analyzeMessage({ message, model, apiKey, signal }: {
  message: string; model: string; apiKey: string; signal: AbortSignal;
}): Promise<Analysis> {
  const timeout = AbortSignal.timeout(45000);
  const abortSignal = AbortSignal.any([signal, timeout]);
  try {
    abortSignal.throwIfAborted();
    await checkModelSupport(model, abortSignal);
    const openrouter = createOpenRouter({
      apiKey,
      // Wersja 3.1.0 nie udostępnia message.refusal w wyniku SDK.
      // Sprawdzamy jawną odmowę przed parsowaniem odpowiedzi przez provider.
      fetch: async (url, options) => {
        const response = await fetch(url, options);
        if (response.ok) {
          let body: unknown;
          try {
            body = await response.clone().json();
          } catch (error) {
            throw new AnalysisError(error instanceof SyntaxError ? "invalid" : "interrupted");
          }
          if (hasRefusal(body)) throw new AnalysisError("refused");
        }
        return response;
      },
    });
    const result = await generateText({
      model: openrouter.chat(model, {
        structuredOutputs: { strict: true },
        provider: { require_parameters: true, allow_fallbacks: false },
      }),
      instructions,
      messages: [{ role: "user", content: message }],
      output: Output.object({ name: "studio_nova_analysis", schema: analysisSchema }),
      abortSignal,
      maxRetries: 0,
    });
    abortSignal.throwIfAborted();
    checkFinishReason(result.finishReason);
    // Output.object używa validateAnalysis. Dodatkowo sprawdzamy wynik na granicy API.
    const validated = validateAnalysis(result.output);
    if (!validated.success) throw new AnalysisError("invalid");
    return validated.value;
  } catch (error) {
    if (signal.aborted) throw new AnalysisError("cancelled");
    if (timeout.aborted) throw new AnalysisError("interrupted");
    if (error instanceof AnalysisError) throw error;
    if (NoObjectGeneratedError.isInstance(error)) {
      if (error.finishReason) checkFinishReason(error.finishReason);
      throw new AnalysisError("invalid");
    }
    if (NoOutputGeneratedError.isInstance(error)) throw new AnalysisError("invalid");
    if (APICallError.isInstance(error) && [400, 404, 422].includes(error.statusCode ?? 0)) {
      throw new AnalysisError("configuration");
    }
    throw new AnalysisError("provider");
  }
}
