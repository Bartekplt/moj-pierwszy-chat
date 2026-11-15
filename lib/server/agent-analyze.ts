import { analyzeMessage, AnalysisError } from "./analysis.ts";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function analysisResponse(request: Request, body: unknown) {
  let message: string;
  try {
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length !== 2 || !("message" in body) ||
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
