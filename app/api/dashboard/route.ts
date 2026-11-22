import { hasRequestSession, isSameOrigin } from "../../../lib/server/session.ts";
import { loadTravelDashboard, travelInput, type TravelDashboardEvent } from "../../../lib/server/travel-dashboard.ts";
import { travelStreamType } from "../../../lib/travel-dashboard-stream.ts";

export const runtime = "nodejs";
export const maxDuration = 60;
const loadError = "Nie udało się pobrać danych podróży. Spróbuj ponownie.";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!hasRequestSession(request)) return json({ error: "Zaloguj się ponownie, żeby sprawdzić podróż." }, 401);
  if (!isSameOrigin(request)) return json({ error: "Niedozwolone pochodzenie żądania." }, 403);
  const result = travelInput.safeParse(await request.json().catch(() => null));
  if (!result.success) return json({ error: "Podaj poprawną datę i nazwę miasta. Do porównania wpisz dwa różne miasta." }, 400);

  if (request.headers.get("accept") === travelStreamType) {
    const canceled = new AbortController();
    const signal = AbortSignal.any([request.signal, canceled.signal]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: TravelDashboardEvent) => {
          if (!signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        try {
          const data = await loadTravelDashboard(result.data, signal, send);
          if ("blad" in data) send({ type: "error", message: data.blad });
        } catch {
          send({ type: "error", message: loadError });
        } finally {
          if (!canceled.signal.aborted) controller.close();
        }
      },
      cancel() { canceled.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": `${travelStreamType}; charset=utf-8`, "Cache-Control": "no-store" } });
  }

  try {
    const data = await loadTravelDashboard(result.data, request.signal);
    return "blad" in data ? json({ error: data.blad }, 422) : json(data);
  } catch {
    return json({ error: loadError }, 502);
  }
}
