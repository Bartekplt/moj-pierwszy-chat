import type { z } from "zod";
import { toolTimeoutMs } from "./chat-task.ts";

export async function fetchData<T>(url: URL, schema: z.ZodType<T>, abortSignal?: AbortSignal, userAgent?: string) {
  const timeout = AbortSignal.timeout(toolTimeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout,
      headers: { Accept: "application/json", ...(userAgent && { "User-Agent": userAgent }) },
    });
    if (!response.ok) return { ok: false as const, status: response.status };
    const parsed = schema.safeParse(await response.json());
    if (parsed.success) return { ok: true as const, data: parsed.data };
  } catch {
    // Treść odpowiedzi dostawcy i wyjątki sieciowe nie trafiają do rozmowy.
  }
  return { ok: false as const, status: null };
}
