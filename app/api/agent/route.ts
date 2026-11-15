import { hasRequestSession, isSameOrigin } from "../../../lib/server/session.ts";
import { chatResponse } from "../../../lib/server/agent-chat.ts";
import { analysisResponse } from "../../../lib/server/agent-analyze.ts";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  // Kontrola dostępu poprzedza parsowanie body i każdą pracę z modelem.
  if (!hasRequestSession(request)) return Response.json({
    error: "Sesja wygasła lub nie jesteś zalogowany. Wpisz hasło ponownie.",
  }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (!isSameOrigin(request)) return Response.json({ error: "Niedozwolone pochodzenie żądania." }, { status: 403 });

  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Nieprawidłowe dane JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !("mode" in body)) {
    return Response.json({ error: "Wybierz tryb: chat albo analyze." }, { status: 400 });
  }
  if (body.mode === "chat") return chatResponse(request, body);
  if (body.mode === "analyze") return analysisResponse(request, body);
  return Response.json({ error: "Nieznany tryb. Wybierz chat albo analyze." }, { status: 400 });
}
