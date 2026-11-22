import type { UIMessage } from "ai";
import { DOCUMENT_TYPES } from "./documents.ts";

export const chatToolLabels = {
  web_search: "🔎 wyszukiwanie",
  aktualnyCzas: "🕒 aktualnyCzas",
  generujObraz: "🎨 generujObraz",
  czytajPdf: "📄 PDF",
  arkusze: "📊 arkusze",
  pogoda: "🌦️ pogoda",
  waluty: "💱 waluty",
  swieta: "📅 święta",
  wikipedia: "📚 Wikipedia",
  kalkulator: "🧮 kalkulator",
  czas: "🕒 czas",
  notatki: "📝 notatki",
  diagnostyka: "⚙️ diagnostyka",
  oswiadczeniaZdrowotneUE: "📋 Oświadczenia zdrowotne UE",
} as const;

export type ChatToolName = keyof typeof chatToolLabels;
export type ChatToolStep = { step: number; tools: ChatToolName[] };
export type ChatMessage = UIMessage<{
  retrievedAt?: string; usedTools?: ChatToolName[]; toolSteps?: ChatToolStep[];
  modelId?: string | null; vision?: boolean;
  statistics?: { steps: number; toolCalls: number; elapsedMs: number };
  interrupted?: boolean; partialResults?: string[];
}>;

export function markChatInterrupted(messages: ChatMessage[], response: ChatMessage): ChatMessage[] {
  const index = messages.findLastIndex(({ id }) => id === response.id);
  const interrupted = { ...response, metadata: { ...response.metadata, interrupted: true } };
  return index === -1 ? [...messages, interrupted] : messages.with(index, interrupted);
}

// Plik zostaje w przeglądarce. Historia do serwera zawiera tylko potwierdzenie.
export function prepareAgentMessages(messages: ChatMessage[]): ChatMessage[] {
  const lastDocuments = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts) {
      if (part.type === "file" && DOCUMENT_TYPES.includes(part.mediaType)) lastDocuments.set(part.mediaType, message.id);
    }
  }
  return messages.filter(({ metadata, parts }) => !metadata?.interrupted || parts.length > 0).map((message) => ({ ...message, parts: message.parts.map((part) => {
    if (part.type === "file" && DOCUMENT_TYPES.includes(part.mediaType) && lastDocuments.get(part.mediaType) !== message.id) {
      return { type: "text", text: `Wcześniejszy załącznik: ${part.filename ?? "dokument"}` };
    }
    if ((part.type === "tool-generujObraz" || (part.type === "dynamic-tool" && part.toolName === "generujObraz")) &&
      part.state === "output-available") return { ...part, output: "obraz wygenerowany" };
    if ((part.type === "tool-arkusze" || (part.type === "dynamic-tool" && part.toolName === "arkusze")) &&
      part.state === "output-available") return { ...part, output: "wynik operacji na arkuszu" };
    if ((part.type === "tool-czytajPdf" || (part.type === "dynamic-tool" && part.toolName === "czytajPdf")) &&
      part.state === "output-available") return { ...part, output: "wynik odczytu PDF" };
    return part;
  }) }));
}
