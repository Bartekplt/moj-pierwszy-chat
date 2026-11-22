import type { ToolSet } from "ai";
import { type ChatToolName } from "../chat.ts";
import { ImageGenerationError } from "./image-errors.ts";

export const chatTimeoutMs = 60_000;
export const toolTimeoutMs = 10_000;
export const sourceTimeoutMessage = "źródło nie odpowiada";

export class ChatToolError extends Error {}

export async function abortable<T>(signal: AbortSignal, run: () => T | PromiseLike<T>): Promise<T> {
  signal.throwIfAborted();
  let rejectOnAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, run()]);
  } finally {
    signal.removeEventListener("abort", rejectOnAbort);
  }
}

export function createChatTask(requestSignal: AbortSignal, startedAt: number) {
  const toolLimit = 16;
  const deadline = AbortSignal.timeout(Math.max(0, Math.ceil(chatTimeoutMs - (performance.now() - startedAt))));
  const signal = AbortSignal.any([requestSignal, deadline]);
  const executed = new Set<string>();
  let searches = 0;
  let failure: { name: ChatToolName; message: string } | undefined;
  const count = () => executed.size + searches;
  const recordFailure = (name: ChatToolName, message: string) => { failure ??= { name, message }; };

  function limitTools<T extends ToolSet>(tools: T): T {
    const bounded = { ...tools };
    for (const [name, definition] of Object.entries(tools)) {
      const execute = definition.execute;
      if (!execute) continue;
      Reflect.set(bounded, name, { ...definition, execute: async (input, options) => {
        signal.throwIfAborted();
        if (failure || count() >= toolLimit || executed.has(options.toolCallId)) {
          throw new ChatToolError("Pominięto narzędzie po zakończeniu zbierania danych.");
        }
        executed.add(options.toolCallId);
        const toolDeadline = AbortSignal.timeout(toolTimeoutMs);
        const executionSignal = AbortSignal.any([signal, toolDeadline, ...(options.abortSignal ? [options.abortSignal] : [])]);
        try {
          const output = await abortable(executionSignal, () => execute(input, { ...options, abortSignal: executionSignal }));
          if (output && typeof output === "object" && "blad" in output && typeof output.blad === "string") {
            recordFailure(name as ChatToolName, output.blad);
          }
          return output;
        } catch (error) {
          if (signal.aborted) throw error;
          const failureError = toolDeadline.aborted || (error instanceof Error && error.name === "TimeoutError")
            ? new ChatToolError(sourceTimeoutMessage)
            : error instanceof ImageGenerationError || error instanceof ChatToolError ? error
            : new ChatToolError("Nie udało się wykonać narzędzia.");
          recordFailure(name as ChatToolName, failureError.message);
          throw failureError;
        }
      } } satisfies typeof definition);
    }
    return bounded;
  }

  return {
    signal, deadline, executed, limitTools, count, toolLimit,
    recordSearch: (n: number) => { searches += n; },
    recordFailure,
    get failure() { return failure; },
    elapsedMs: () => Math.round(performance.now() - startedAt),
  };
}
