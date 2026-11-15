import { studioNovaInstructions } from "./studio-nova.ts";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { aktualnyCzas } from "./chat-tools.ts";
import { createImageTool, imageGenerationError } from "./image-generation.ts";
import type { ChatMessage, ChatToolName } from "../chat.ts";
import { isValidPhoto } from "./image-input.ts";
import { IMAGE_INPUT_ERROR } from "../images.ts";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  validateUIMessages,
  wrapLanguageModel,
  type TextStreamPart,
} from "ai";

const responseError =
  "Nie udało się uzyskać odpowiedzi. Sprawdź klucz, identyfikator modelu i środki w OpenRouter, a następnie spróbuj ponownie.";

export async function chatResponse(request: Request, body: unknown) {
  let messages: ChatMessage[];

  try {
    if (!body || typeof body !== "object" || !("messages" in body)) {
      throw new Error("Brak wiadomości");
    }
    messages = await validateUIMessages<ChatMessage>({ messages: body.messages });
    for (const message of messages) {
      const photos = message.parts.filter((part) => part.type === "file");
      if (photos.length > 1 || photos.some((part) => message.role !== "user" || !isValidPhoto(part))) {
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
            ["source-url", "tool-aktualnyCzas", "tool-web_search", "tool-generujObraz"].includes(part.type) ||
            (part.type === "dynamic-tool" && ["aktualnyCzas", "web_search", "generujObraz"].includes(part.toolName))
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

  const vision = messages.some((message) => message.parts.some((part) => part.type === "file"));
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
    const openrouter = createOpenRouter({ apiKey });
    const tools = {
      web_search: openrouter.tools.webSearch({ maxResults: 3, engine: "native" }),
      aktualnyCzas,
      generujObraz: createImageTool(apiKey!, request.signal),
    };
    const usedTools: ChatToolName[] = [];
    const seenToolCalls = new Set<string>();
    let webSearchInStep = false;
    let nativeSearchPending = false;
    const modelResponses: Array<{ modelId: string | null }> = [];
    const trackedModel = wrapLanguageModel({ model: openrouter(model!), middleware: {
      specificationVersion: "v4",
      wrapStream: async ({ doStream }) => {
        const metadata = { modelId: null as string | null };
        modelResponses.push(metadata);
        const response = await doStream();
        return { ...response, stream: response.stream.pipeThrough(new TransformStream({
          transform(part, controller) {
            // Odczyt przed uzupełnieniem brakujących metadanych przez AI SDK.
            if (part.type === "response-metadata" && part.modelId) metadata.modelId = part.modelId;
            controller.enqueue(part);
          },
        })) };
      },
    } });
    const result = streamText({
      model: trackedModel,
      tools,
      stopWhen: isStepCount(5),
      instructions: `${studioNovaInstructions}\n\nBieżąca data (Europe/Warsaw): ${new Date().toLocaleDateString("pl-PL", { timeZone: "Europe/Warsaw" })}.`,
      // Do modelu trafiają tekst, zdjęcia użytkownika i krótkie potwierdzenia obrazów.
      messages: await convertToModelMessages(messages.map(({ id, role, parts }) => ({
        id, role, parts: parts.flatMap((part): ChatMessage["parts"] => {
          if (part.type === "text" || part.type === "file") return [part];
          if ((part.type === "tool-generujObraz" || (part.type === "dynamic-tool" && part.toolName === "generujObraz")) &&
            part.state === "output-available") return [{ type: "text", text: "obraz wygenerowany" }];
          return [];
        }),
      })), { tools }),
      abortSignal: request.signal,
      maxRetries: 0,
      // Szczegóły błędów dostawcy nie trafiają do przeglądarki ani logów.
      onError: () => {},
    });

    let completedSteps = 0;
    let hasText = false;
    let interrupted = false;
    const responseStream = result.stream.pipeThrough(new TransformStream<
      TextStreamPart<typeof tools>, TextStreamPart<typeof tools>
    >({
      transform(part, controller) {
        if (part.type === "finish-step") completedSteps++;
        if (part.type === "text-delta" && part.text.trim()) hasText = true;
        if (part.type === "abort" || part.type === "error") interrupted = true;
        // Zakończenie narzędziami na piątym kroku oznacza brak miejsca na dalszą odpowiedź.
        // Odpowiedź ukończona naturalnie w piątym kroku nie wymaga tego komunikatu.
        if (part.type === "finish" && part.finishReason === "tool-calls" && completedSteps >= 5 && !interrupted) {
          const id = "agent-step-limit";
          controller.enqueue({ type: "text-start", id });
          controller.enqueue({ type: "text-delta", id, text: `${hasText ? "\n\n" : ""}Przerwałem po 5 krokach` });
          controller.enqueue({ type: "text-end", id });
        }
        controller.enqueue(part);
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
            webSearchInStep = false;
            nativeSearchPending = false;
          }
          if (part.type === "finish-step") return { modelId: modelResponses.shift()?.modelId ?? null, vision };
          if (part.type === "source" && part.sourceType === "url") {
            // Natywne wyszukiwanie może zwrócić źródła bez jawnego tool-call.
            if (!webSearchInStep) {
              usedTools.push("web_search");
              webSearchInStep = true;
              nativeSearchPending = true;
            }
            return { retrievedAt: new Date().toISOString(), usedTools: [...usedTools] };
          }
          if (part.type === "tool-call" && !part.invalid &&
            (part.toolName === "aktualnyCzas" || part.toolName === "web_search" || part.toolName === "generujObraz")) {
            if (seenToolCalls.has(part.toolCallId)) return;
            seenToolCalls.add(part.toolCallId);
            // Źródło i jawne wywołanie tej samej operacji nie tworzą dwóch etykiet.
            if (part.toolName === "web_search" && nativeSearchPending) {
              nativeSearchPending = false;
            } else {
              usedTools.push(part.toolName);
            }
            if (part.toolName === "web_search") webSearchInStep = true;
            return { usedTools: [...usedTools] };
          }
        },
        onError: (error) => error instanceof Error && error.message === imageGenerationError
          ? imageGenerationError : currentResponseError,
      }),
    });
  } catch {
    return new Response(currentResponseError, { status: 502 });
  }
}
