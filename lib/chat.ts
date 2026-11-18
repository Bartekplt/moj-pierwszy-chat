import type { UIMessage } from "ai";
import { DOCUMENT_TYPES } from "./documents.ts";

export const chatToolLabels = {
  web_search: "🔎 wyszukiwanie",
  aktualnyCzas: "🕒 aktualnyCzas",
  generujObraz: "🎨 generujObraz",
  czytajPdf: "📄 PDF",
  arkusze: "📊 arkusze",
} as const;

export type ChatToolName = keyof typeof chatToolLabels;
export type ChatMessage = UIMessage<{
  retrievedAt?: string; usedTools?: ChatToolName[];
  modelId?: string | null; vision?: boolean;
}>;

// Plik zostaje w przeglądarce. Historia do serwera zawiera tylko potwierdzenie.
export function prepareAgentMessages(messages: ChatMessage[]): ChatMessage[] {
  const lastDocuments = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts) {
      if (part.type === "file" && DOCUMENT_TYPES.includes(part.mediaType)) lastDocuments.set(part.mediaType, message.id);
    }
  }
  return messages.map((message) => ({ ...message, parts: message.parts.map((part) => {
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
