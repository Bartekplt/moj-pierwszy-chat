import type { TravelDashboardEvent } from "./server/travel-dashboard.ts";

export const travelStreamType = "application/x-ndjson";

export const travelCardSources = {
  weather: "Open-Meteo",
  currency: "Narodowy Bank Polski",
  holidays: "Nager.Date",
  wiki: "Wikipedia (PL)",
  time: "Zegar systemowy · strefy IANA",
  msz: "MSZ · Odyseusz",
} as const;

export async function readTravelEvents(body: ReadableStream<Uint8Array<ArrayBuffer>>, onEvent: (event: TravelDashboardEvent) => void) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (buffer + value).split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line) onEvent(JSON.parse(line));
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
