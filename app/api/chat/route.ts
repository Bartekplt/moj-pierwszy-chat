import { studioNovaInstructions } from "../../../lib/server/studio-nova.ts";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { hasRequestSession, isSameOrigin } from "../../../lib/server/session.ts";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  validateUIMessages,
  type UIMessage,
} from "ai";

export const runtime = "nodejs";

const responseError =
  "Nie udało się uzyskać odpowiedzi. Sprawdź klucz, identyfikator modelu i środki w OpenRouter, a następnie spróbuj ponownie.";

export async function POST(request: Request) {
  if (!hasRequestSession(request)) {
    return new Response("Sesja wygasła lub nie jesteś zalogowany. Wpisz hasło ponownie.", {
      status: 401, headers: { "Cache-Control": "no-store" },
    });
  }
  if (!isSameOrigin(request)) {
    return new Response("Niedozwolone pochodzenie żądania.", { status: 403 });
  }
  let messages: UIMessage[];

  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("messages" in body)) {
      throw new Error("Brak wiadomości");
    }
    messages = await validateUIMessages({ messages: body.messages });
    const lastMessage = messages.at(-1);
    if (
      !messages.length ||
      messages.some((message) =>
        !["user", "assistant"].includes(message.role) ||
        message.parts.some((part) => !["text", "step-start"].includes(part.type)),
      ) ||
      lastMessage?.role !== "user" ||
      !lastMessage.parts.some((part) => part.type === "text" && part.text.trim())
    ) {
      throw new Error("Nieprawidłowe wiadomości");
    }
  } catch {
    return new Response("Nieprawidłowa rozmowa. Wpisz niepustą wiadomość.", { status: 400 });
  }

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
    const result = streamText({
      model: openrouter(model!),
      instructions: studioNovaInstructions,
      messages: await convertToModelMessages(messages),
      abortSignal: request.signal,
      maxRetries: 0,
      // Szczegóły błędów dostawcy nie trafiają do przeglądarki ani logów.
      onError: () => {},
    });

    // AI SDK 7: osobny konwerter strumienia do protokołu useChat.
    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        originalMessages: messages,
        sendReasoning: false,
        onError: () => responseError,
      }),
    });
  } catch {
    return new Response(responseError, { status: 502 });
  }
}
