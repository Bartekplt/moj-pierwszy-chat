import type { UIMessage } from "ai";

export const chatToolLabels = {
  web_search: "🔎 wyszukiwanie",
  aktualnyCzas: "🕒 aktualnyCzas",
  generujObraz: "🎨 generujObraz",
} as const;

export type ChatToolName = keyof typeof chatToolLabels;
export type ChatMessage = UIMessage<{
  retrievedAt?: string; usedTools?: ChatToolName[];
  modelId?: string | null; vision?: boolean;
}>;

// Plik zostaje w przeglądarce. Historia do serwera zawiera tylko potwierdzenie.
export function prepareAgentMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({ ...message, parts: message.parts.map((part) => {
    if ((part.type === "tool-generujObraz" || (part.type === "dynamic-tool" && part.toolName === "generujObraz")) &&
      part.state === "output-available") return { ...part, output: "obraz wygenerowany" };
    return part;
  }) }));
}
