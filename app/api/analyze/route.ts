import { analyzeMessage, AnalysisError } from "../../../lib/server/analysis.ts";
import { hasRequestSession, isSameOrigin } from "../../../lib/server/session.ts";

export const runtime = "nodejs";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!hasRequestSession(request)) {
    return json({ error: "Sesja wygasła lub nie jesteś zalogowany. Wpisz hasło ponownie." }, 401);
  }
  if (!isSameOrigin(request)) return json({ error: "Niedozwolone pochodzenie żądania." }, 403);

  let message: string;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !("message" in body) ||
        typeof body.message !== "string" || !body.message.trim() || body.message.length > 12000) {
      throw new Error("Nieprawidłowa wiadomość");
    }
    message = body.message.trim();
  } catch {
    return json({ error: "Podaj niepustą wiadomość klienta (maksymalnie 12 000 znaków)." }, 400);
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim();
  if (!apiKey || !model) {
    return json({ error: "Brak konfiguracji: uzupełnij OPENROUTER_API_KEY i OPENROUTER_MODEL na serwerze i uruchom go ponownie." }, 503);
  }
  try {
    const analysis = await analyzeMessage({ message, model, apiKey, signal: request.signal });
    return json(analysis);
  } catch (error) {
    const failure = error instanceof AnalysisError ? error : new AnalysisError("provider");
    return json({ error: failure.message, code: failure.code }, failure.status);
  }
}
