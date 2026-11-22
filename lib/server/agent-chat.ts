import { assistantInstructions } from "./assistant-persona.ts";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { aktualnyCzas, czas, kalkulator, createDiagnosticsTool } from "./chat-tools.ts";
import { createNotesTool } from "./notes-tool.ts";
import { pogoda, swieta, waluty, wikipedia } from "./public-data-tools.ts";
import { oswiadczeniaZdrowotneUE } from "./health-claims-tool.ts";
import { createImageTool } from "./image-generation.ts";
import { ImageGenerationError } from "./image-errors.ts";
import { imageFailureMessages } from "../image-errors.ts";
import { chatToolLabels, type ChatMessage, type ChatToolName, type ChatToolStep } from "../chat.ts";
import { partialToolResult } from "./partial-tool-result.ts";
import { abortable, ChatToolError, createChatTask, sourceTimeoutMessage, toolTimeoutMs } from "./chat-task.ts";
import { isValidPhoto } from "./image-input.ts";
import { IMAGE_INPUT_ERROR, IMAGE_TYPES } from "../images.ts";
import { DOCUMENT_INPUT_ERROR, DOCUMENT_TYPES, PDF_TYPE, XLSX_TYPE } from "../documents.ts";
import { googleIds } from "../spreadsheets.ts";
import { decodeDocument, type ChatDocument } from "./document-input.ts";
import { createPdfTool } from "./pdf-tool.ts";
import { createSpreadsheetTool } from "./spreadsheet-tool.ts";
import {
  APICallError,
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  InvalidToolInputError,
  streamText,
  toUIMessageStream,
  validateUIMessages,
  wrapLanguageModel,
  type TextStreamPart,
} from "ai";

const responseError =
  "Nie udało się uzyskać odpowiedzi. Sprawdź klucz, identyfikator modelu i środki w OpenRouter, a następnie spróbuj ponownie.";
const parcelNumber = new Intl.NumberFormat("pl-PL");
const parcelPlural = new Intl.PluralRules("pl");

function calculationPlan(message: ChatMessage | undefined) {
  if (message?.parts.some((part) => part.type === "file")) return;
  const text = message?.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "";
  const steps = [...text.matchAll(/^[ \t]*(\d+)\.[ \t]*\*{0,2}(waluty|kalkulator|podsumowanie):\*{0,2}[ \t]*/gim)];
  const summary = steps.at(-1);
  if (steps.length < 3 || summary?.[2].toLowerCase() !== "podsumowanie"
    || !steps.every((step, index) => Number(step[1]) === index + 1)) return;
  const operations = steps.slice(0, -1).map((step, index) => ({
    name: step[2].toLowerCase(),
    instruction: text.slice(step.index + step[0].length, steps[index + 1].index).trim(),
  }));
  if (!operations.every(({ name, instruction }) => (name === "waluty" || name === "kalkulator") && instruction)) return;
  return {
    context: text.slice(0, steps[0].index).trim(),
    operations: operations.map(({ name, instruction }) => ({
      tool: name === "waluty" ? "waluty" as const : "kalkulator" as const, instruction,
    })),
    summary: text.slice(summary.index + summary[0].length).trim(),
  };
}

export async function chatResponse(request: Request, body: unknown, startedAt = performance.now(), chatStepLimit = 10) {
  let messages: ChatMessage[];
  const documents = new Map<string, ChatDocument>();

  try {
    if (!body || typeof body !== "object" || !("messages" in body)) {
      throw new Error("Brak wiadomości");
    }
    messages = await validateUIMessages<ChatMessage>({ messages: body.messages });
    for (const message of messages) {
      const files = message.parts.filter((part) => part.type === "file");
      if (files.length > 1 || (files.length && message.role !== "user")) {
        return new Response(IMAGE_INPUT_ERROR, { status: 400 });
      }
      const file = files[0];
      if (!file) continue;
      if (DOCUMENT_TYPES.includes(file.mediaType)) {
        const document = decodeDocument(file);
        if (!document) return new Response(DOCUMENT_INPUT_ERROR, { status: 400 });
        documents.set(file.mediaType, document);
      } else if (!isValidPhoto(file)) {
        return new Response(IMAGE_INPUT_ERROR, { status: 400 });
      }
    }
    const lastMessage = messages.at(-1);
    if (
      !messages.length ||
      messages.some((message) =>
        !["user", "assistant"].includes(message.role) ||
        message.parts.some((part) =>
          !["text", "step-start"].includes(part.type) &&
          !(message.role === "user" && part.type === "file") &&
          !(message.role === "assistant" && (
            part.type === "source-url" ||
            (part.type.startsWith("tool-") && Object.hasOwn(chatToolLabels, part.type.slice(5))) ||
            (part.type === "dynamic-tool" && Object.hasOwn(chatToolLabels, part.toolName))
          )),
        ),
      ) ||
      lastMessage?.role !== "user" ||
      !lastMessage.parts.some((part) => (part.type === "text" && part.text.trim()) || part.type === "file")
    ) {
      throw new Error("Nieprawidłowe wiadomości");
    }
  } catch {
    return new Response("Nieprawidłowa rozmowa. Wpisz niepustą wiadomość.", { status: 400 });
  }

  const vision = messages.some((message) => message.parts.some((part) => part.type === "file" && IMAGE_TYPES.includes(part.mediaType)));
  const currentResponseError = vision
    ? "Nie udało się przeanalizować zdjęcia. Model rozmowy może być niedostępny albo nie obsługiwać obrazów. Spróbuj ponownie lub wybierz w konfiguracji model z obsługą zdjęć."
    : responseError;

  // Te zmienne są odczytywane wyłącznie przez serwer.
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim();
  const missing = [
    !apiKey && "OPENROUTER_API_KEY",
    !model && "OPENROUTER_MODEL",
  ].filter(Boolean);

  if (missing.length) {
    return new Response(
      `Brak konfiguracji: ${missing.join(", ")}. Uzupełnij .env.local w folderze projektu i uruchom ponownie serwer.`,
      { status: 503 },
    );
  }

  try {
    const task = createChatTask(request.signal, startedAt);
    let searchDeadline: AbortSignal | undefined;
    const openrouter = createOpenRouter({ apiKey, fetch: (url, options) => {
      if (!searchDeadline) return fetch(url, options);
      const signal = AbortSignal.any([searchDeadline, options?.signal ?? task.signal]);
      return abortable(signal, () => fetch(url, { ...options, signal }));
    } });
    const chatModel = openrouter.chat(model!, { extraBody: { max_tool_calls: 1 } });
    const sheetLinks = googleIds(messages.flatMap(({ role, parts }) =>
      role === "user" ? parts.flatMap((part) => part.type === "text" ? [part.text] : []) : [],
    ));
    const tools = task.limitTools({
      web_search: openrouter.tools.webSearch({ maxResults: 3, engine: "native" }),
      aktualnyCzas,
      generujObraz: createImageTool(apiKey!, request.signal),
      czytajPdf: createPdfTool(documents.get(PDF_TYPE)),
      arkusze: createSpreadsheetTool(request, documents.get(XLSX_TYPE), sheetLinks),
      pogoda, waluty, swieta, wikipedia, kalkulator, czas,
      oswiadczeniaZdrowotneUE,
      notatki: createNotesTool(request),
      diagnostyka: createDiagnosticsTool(chatModel.modelId, (): string[] => Object.keys(tools), chatStepLimit),
    } satisfies Record<ChatToolName, unknown>);
    const usedTools: ChatToolName[] = [];
    const toolSteps: ChatToolStep[] = [];
    const seenToolCalls = new Set<string>();
    let stepNumber = 0;
    let webSearchInStep = false;
    let nativeSearchPending = false;

    function recordToolUse(name: ChatToolName) {
      usedTools.push(name);
      const lastStep = toolSteps.at(-1);
      if (lastStep?.step === stepNumber) lastStep.tools.push(name);
      else toolSteps.push({ step: stepNumber, tools: [name] });
    }

    function toolMetadata() {
      return { usedTools: [...usedTools], toolSteps: toolSteps.map(({ step, tools }) => ({ step, tools: [...tools] })), partialResults: [...observations] };
    }

    let modelCalls = 0;
    const modelResponses: Array<{ modelId: string | null }> = [];
    const trackedModel = wrapLanguageModel({ model: chatModel, middleware: {
      specificationVersion: "v4",
      wrapStream: async ({ doStream, params }) => {
        modelCalls++;
        const metadata = { modelId: null as string | null };
        modelResponses.push(metadata);
        // Wyszukiwanie natywne jest częścią odpowiedzi OpenRouter, a nie lokalnym execute().
        const searchAllowed = params.toolChoice?.type !== "none" && params.tools?.some((tool) =>
          tool.type === "provider" && tool.id === "openrouter.web_search");
        searchDeadline = searchAllowed ? AbortSignal.timeout(toolTimeoutMs) : undefined;
        let searches = 0;
        const response = await doStream();
        return { ...response, stream: response.stream.pipeThrough(new TransformStream({
          transform(part, controller) {
            // Odczyt przed uzupełnieniem brakujących metadanych przez AI SDK.
            if (part.type === "response-metadata" && part.modelId) metadata.modelId = part.modelId;
            if (searchAllowed) {
              const usage = part.type === "raw" ? (part.rawValue as { usage?: { server_tool_use?: { web_search_requests?: number } } } | null)?.usage : undefined;
              const reported = usage?.server_tool_use?.web_search_requests ?? 0;
              const isSearch = (part.type === "source" && part.sourceType === "url") ||
                (part.type === "tool-call" && part.toolName === "web_search");
              const observed = Math.max(isSearch ? 1 : 0, Number.isSafeInteger(reported) ? reported : 0);
              if (observed > searches) {
                task.recordSearch(observed - searches);
                searches = observed;
              }
            }
            if (part.type === "finish" && !searchDeadline?.aborted) searchDeadline = undefined;
            controller.enqueue(part);
          },
        })) };
      },
    } });
    const instructions = `${assistantInstructions}\n\nBieżąca data (Europe/Warsaw): ${new Date().toLocaleDateString("pl-PL", { timeZone: "Europe/Warsaw" })}.`;
    const plan = calculationPlan(messages.at(-1));
    const toolsWithoutSearch = (Object.keys(tools) as ChatToolName[]).filter((name) => name !== "web_search");
    let summaryStep: number | undefined;
    let toolFailureStep: number | undefined;
    let hitStepLimit = false;
    const result = streamText({
      model: trackedModel,
      tools,
      stopWhen: isStepCount(chatStepLimit),
      instructions,
      prepareStep: ({ stepNumber, steps, initialMessages }) => {
        hitStepLimit = stepNumber === chatStepLimit - 1;
        const plannedStep = plan?.operations[stepNumber];
        const summarize = hitStepLimit || Boolean(task.failure) || task.count() >= task.toolLimit;
        // Model dostaje tylko bieżącą czynność i wyniki wykorzystane w tej rozmowie.
        const planMessages = plan ? [...initialMessages.slice(0, -1), {
          role: "user" as const,
          content: [
            plan.context,
            `Zweryfikowane wyniki poprzednich kroków planu:`,
            ...steps.flatMap((step, index) => step.toolResults.flatMap(({ toolName, output }) => {
              if (toolName !== "waluty" && toolName !== "kalkulator") return [];
              const result = partialToolResult(toolName, output);
              return result ? [`${index + 1}. ${result}`] : [];
            })),
            !summarize && plannedStep
              ? `Wykonaj tylko bieżącą czynność narzędziem ${plannedStep.tool}: ${plannedStep.instruction}`
              : `Podsumuj ustalenia: ${plan.summary}`,
          ].filter(Boolean).join("\n"),
        }] : undefined;
        if (!summarize) {
          if (!plan) return;
          if (plannedStep) return {
            messages: planMessages, activeTools: [plannedStep.tool], toolChoice: { type: "tool", toolName: plannedStep.tool },
          };
        }
        summaryStep = stepNumber + 1;
        return {
          messages: planMessages,
          toolChoice: "none",
          activeTools: toolsWithoutSearch,
          instructions: `${instructions}\n\nTo ostatni krok. Podsumuj w odpowiedzi zweryfikowane wyniki z dotychczasowych kroków ` +
            "i jasno wskaż, czego nie udało się ustalić. Po błędzie nie ponawiaj wywołania. Komunikat końcowy dopisze aplikacja.",
        };
      },
      // Do modelu trafiają tekst, zdjęcia użytkownika i krótkie potwierdzenia obrazów.
      messages: await convertToModelMessages(messages.map(({ id, role, parts }) => ({
        id, role, parts: parts.flatMap((part): ChatMessage["parts"] => {
          if (part.type === "text") return [part];
          if (part.type === "file") {
            if (IMAGE_TYPES.includes(part.mediaType)) return [part];
            return [{ type: "text", text: `Użytkownik załączył dokument: ${part.filename}` }];
          }
          if ((part.type === "tool-generujObraz" || (part.type === "dynamic-tool" && part.toolName === "generujObraz")) &&
            part.state === "output-available") return [{ type: "text", text: "obraz wygenerowany" }];
          return [];
        }),
      })), { tools }),
      abortSignal: task.signal,
      includeRawChunks: true,
      toolCallConcurrency: 1,
      maxRetries: 0,
      onStepEnd: ({ content, stepNumber }) => {
        if (!task.failure && !summaryStep) {
          for (const part of content) {
            if (part.type !== "tool-error" || !Object.hasOwn(chatToolLabels, part.toolName)) continue;
            const name = part.toolName as ChatToolName;
            task.recordFailure(name, name === "generujObraz" ? imageFailureMessages.input : "Narzędzie zwróciło błąd.");
            break;
          }
        }
        if (task.failure) toolFailureStep ??= stepNumber + 1;
      },
      // Podsumowanie błędu obsługuje strumień poniżej.
      onError: () => {},
    });

    type ChatStreamPart = TextStreamPart<typeof tools>;
    const shippingRequest = messages.at(-1)?.parts.some((part) => part.type === "text" && /paczek|paczk|przesył/iu.test(part.text));
    let shippingClockStep = 0;
    let shippingHolidaysStep = 0;
    let shippingResult: { step: number; days: number; dailyLimit: number; total: number } | undefined;
    let shippingSummaryComplete = false;
    const shippingSummaryText: ChatStreamPart[] = [];
    let startedSteps = 0;
    let hasText = false;
    let finalStepHasText = false;
    let finalStepFailed = false;
    let modelFailure: { step: number; message: string } | undefined;
    let canceled = false;
    let limitReported = false;
    const observations = new Set<string>();
    const invalidImageCalls = new Set<string>();

    function reportModelFailure(error: unknown) {
      if (modelFailure) return;
      const status = APICallError.isInstance(error) ? error.statusCode : undefined;
      const step = Math.max(modelCalls, startedSteps, 1);
      if (plan) {
        console.warn("calculation_plan_model_error", {
          step, status, kind: searchDeadline?.aborted ? "search_timeout" : status ? "http" : "stream",
        });
      }
      const detail = searchDeadline?.aborted ? `OpenRouter: ${sourceTimeoutMessage}.`
        : status === 429 ? "OpenRouter ograniczył liczbę żądań."
        : status === 402 ? "OpenRouter zgłosił brak środków."
        : status === 401 || status === 403 ? "OpenRouter odmówił dostępu do modelu."
        : status !== undefined && status >= 500 ? "OpenRouter nie mógł dokończyć żądania." : "";
      const problem = vision ? "Nie udało się przeanalizować zdjęcia." : "Nie udało się uzyskać odpowiedzi modelu.";
      modelFailure = { step, message: `${problem}${detail ? ` ${detail}` : ""}` };
    }

    function reportStop(controller: TransformStreamDefaultController<ChatStreamPart>) {
      if (limitReported || canceled || request.signal.aborted) return;
      if (shippingResult && !shippingSummaryComplete && !task.failure) {
        const { step, days, dailyLimit, total } = shippingResult;
        const unit = parcelPlural.select(total) === "one" ? "paczkę" : parcelPlural.select(total) === "few" ? "paczki" : "paczek";
        const result = `Możecie wysłać ${parcelNumber.format(total)} ${unit}.`;
        const calculation = `Obliczenie: ${parcelNumber.format(days)} × ${parcelNumber.format(dailyLimit)} = ${parcelNumber.format(total)}. Kalkulator pomnożył liczbę dni nadawania przez dzienny limit paczek.`;
        const stepNotice = task.deadline.aborted ? `Zatrzymałem się po 60 sekundach, na kroku ${Math.max(modelCalls, startedSteps, 1)}.`
          : hitStepLimit ? `Zatrzymałem się po ${chatStepLimit} krokach.`
          : task.count() >= task.toolLimit ? `Zatrzymałem się po ${task.toolLimit} wywołaniach narzędzi.`
          : `Model nie dokończył podsumowania w kroku ${Math.max(modelFailure?.step ?? modelCalls, step + 1)}.`;
        writeStop(controller, `${result}\n\n${calculation}\n\n${stepNotice}`);
        return;
      }
      const messages = [
        task.deadline.aborted && `Zatrzymałem się po 60 sekundach, na kroku ${Math.max(modelCalls, startedSteps, 1)}.`,
        !task.deadline.aborted && hitStepLimit && `Zatrzymałem się po ${chatStepLimit} krokach`,
        task.count() >= task.toolLimit && `Zatrzymałem się po ${task.toolLimit} wywołaniach narzędzi.`,
        task.failure && `Krok ${toolFailureStep ?? Math.max(startedSteps, 1)}: nie udało się wykonać narzędzia „${chatToolLabels[task.failure.name]}”. ${task.failure.message}`,
        modelFailure && (hitStepLimit && modelFailure.step === chatStepLimit ? modelFailure.message
          : `Zadanie przerwało się na kroku ${modelFailure.step}. ${modelFailure.message}`),
      ].filter(Boolean);
      if (!messages.length) return;
      const needsFallback = finalStepFailed || !finalStepHasText || Boolean(task.failure);
      const fallback = observations.size
        ? `\n\nZebrane informacje:\n${[...observations].map((text) => `• ${text}`).join("\n")}`
        : "\n\nNie udało się potwierdzić wyniku przed końcem zadania.";
      writeStop(controller, `${messages.join("\n")}${needsFallback ? fallback : ""}`);
    }

    function writeStop(controller: TransformStreamDefaultController<ChatStreamPart>, text: string) {
      limitReported = true;
      const id = "agent-step-limit";
      controller.enqueue({ type: "text-start", id });
      controller.enqueue({ type: "text-delta", id, text: `${hasText ? "\n\n" : ""}${text}` });
      controller.enqueue({ type: "text-end", id });
    }

    const responseStream = result.stream.pipeThrough(new TransformStream<ChatStreamPart, ChatStreamPart>({
      transform(part, controller) {
        if (part.type === "tool-call" && part.invalid && part.toolName === "generujObraz") {
          invalidImageCalls.add(part.toolCallId);
          controller.enqueue({ ...part, error: new ImageGenerationError("input") });
          return;
        }
        if (part.type === "tool-error" && invalidImageCalls.has(part.toolCallId)) {
          controller.enqueue({ ...part, error: new ImageGenerationError("input") });
          return;
        }
        if (part.type === "start-step") startedSteps++;
        if (shippingResult && startedSteps > shippingResult.step) {
          if (part.type === "text-start" || part.type === "text-delta" || part.type === "text-end") {
            shippingSummaryText.push(part);
            return;
          }
          if (part.type === "finish-step") {
            const complete = part.finishReason === "stop" && !finalStepFailed
              && shippingSummaryText.some((chunk) => chunk.type === "text-delta" && chunk.text.trim());
            if (complete) {
              for (const chunk of shippingSummaryText) controller.enqueue(chunk);
              shippingSummaryComplete = true;
              hasText = true;
              if (startedSteps === summaryStep) finalStepHasText = true;
            }
            shippingSummaryText.length = 0;
          }
        }
        if (part.type === "text-delta" && part.text.trim()) {
          hasText = true;
          if (startedSteps === summaryStep) finalStepHasText = true;
        }
        if (part.type === "abort") {
          canceled = request.signal.aborted;
          finalStepFailed = true;
          if (!canceled && !task.deadline.aborted) reportModelFailure(undefined);
          reportStop(controller);
        }
        if (part.type === "error") {
          // Błąd modelu nie powinien zastąpić wyników z poprzednich kroków.
          finalStepFailed = true;
          if (!request.signal.aborted && !task.deadline.aborted) reportModelFailure(part.error);
          return;
        }
        if (part.type === "tool-result" && !part.dynamic && !part.preliminary) {
          if (shippingRequest && task.executed.has(part.toolCallId)) {
            if ((part.toolName === "aktualnyCzas" || part.toolName === "czas") && "data" in part.output && !shippingClockStep) {
              shippingClockStep = startedSteps;
            }
            if (part.toolName === "swieta" && "dniWolne" in part.output && shippingClockStep && startedSteps > shippingClockStep) {
              shippingHolidaysStep = startedSteps;
            }
            if (part.toolName === "kalkulator" && "wynik" in part.output && shippingHolidaysStep && startedSteps > shippingHolidaysStep) {
              const { a, b, operacja } = part.input;
              if (operacja === "pomnoz" && [a, b, part.output.wynik].every((n) => Number.isSafeInteger(n) && n >= 0)) {
                shippingResult = { step: startedSteps, days: a, dailyLimit: b, total: part.output.wynik };
              }
            }
          }
          if (observations.size < 8) {
            const observation = partialToolResult(part.toolName, part.output);
            if (observation && observation !== task.failure?.message) {
              observations.add(observation.length > 360 ? `${observation.slice(0, 359)}…` : observation);
            }
          }
        }
        if (part.type === "source" && part.sourceType === "url" && observations.size < 8) {
          observations.add("Odnalezione odnośniki są w źródłach odpowiedzi.");
        }
        if (part.type === "finish") reportStop(controller);
        controller.enqueue(part);
        if (part.type === "tool-result" && !part.dynamic && part.toolName === "wikipedia" && "url" in part.output) {
          controller.enqueue({
            type: "source", sourceType: "url", id: `wikipedia-${part.toolCallId}`,
            title: `${part.output.tytul} — Wikipedia`, url: part.output.url,
            providerMetadata: { laba: { toolRetrievedAt: part.output.pobrano } },
          });
        }
        if (part.type === "tool-result" && !part.dynamic && part.toolName === "oswiadczeniaZdrowotneUE" && "wyniki" in part.output) {
          for (const { id, skladnik, url } of part.output.wyniki) {
            controller.enqueue({
              type: "source", sourceType: "url", id: `${part.toolCallId}-${id}`,
              title: `${skladnik} — ${id}`, url,
              providerMetadata: { laba: { toolRetrievedAt: part.output.pobrano } },
            });
          }
        }
      },
      flush(controller) {
        reportStop(controller);
      },
    }));

    // AI SDK 7: osobny konwerter strumienia do protokołu useChat.
    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: responseStream,
        tools,
        originalMessages: messages,
        sendReasoning: false,
        sendSources: true,
        messageMetadata: ({ part }) => {
          if (part.type === "start-step") {
            stepNumber++;
            webSearchInStep = false;
            nativeSearchPending = false;
          }
          if (part.type === "finish-step") return { modelId: modelResponses.shift()?.modelId ?? null, vision };
          if (part.type === "finish" || part.type === "abort" || (part.type === "text-end" && part.id === "agent-step-limit")) {
            return { statistics: { steps: modelCalls,
              toolCalls: task.count(), elapsedMs: task.elapsedMs() } };
          }
          if (part.type === "source" && part.sourceType === "url") {
            const toolRetrievedAt = part.providerMetadata?.laba?.toolRetrievedAt;
            if (typeof toolRetrievedAt === "string") return { retrievedAt: toolRetrievedAt };
            // Natywne wyszukiwanie może zwrócić źródła bez jawnego tool-call.
            if (!webSearchInStep) {
              recordToolUse("web_search");
              webSearchInStep = true;
              nativeSearchPending = true;
            }
            return { retrievedAt: new Date().toISOString(), ...toolMetadata() };
          }
          const nativeCall = part.type === "tool-call" && !part.invalid && part.toolName === "web_search";
          const localCall = (part.type === "tool-result" || part.type === "tool-error") && task.executed.has(part.toolCallId);
          if ((nativeCall || localCall) && Object.hasOwn(chatToolLabels, part.toolName)) {
            const name = part.toolName as ChatToolName;
            if (seenToolCalls.has(part.toolCallId)) return;
            seenToolCalls.add(part.toolCallId);
            // Źródło i jawne wywołanie tej samej operacji nie tworzą dwóch etykiet.
            if (part.toolName === "web_search" && nativeSearchPending) {
              nativeSearchPending = false;
            } else {
              recordToolUse(name);
            }
            if (part.toolName === "web_search") webSearchInStep = true;
            return toolMetadata();
          }
        },
        onError: (error) => {
          if (error instanceof ChatToolError) return error.message;
          if (error instanceof ImageGenerationError) return error.message;
          if (InvalidToolInputError.isInstance(error) && error.toolName === "generujObraz") return imageFailureMessages.input;
          return currentResponseError;
        },
      }),
    });
  } catch {
    return new Response(currentResponseError, { status: 502 });
  }
}
