import { AUTH_CONFIGURATION_ERROR, checkPassword, createSession, isAuthConfigured, isSameOrigin, sessionCookie } from "../../../lib/server/session.ts";
import { limitLogin } from "../../../lib/server/login-limit.ts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!isSameOrigin(request)) return new Response("Niedozwolone pochodzenie żądania.", { status: 403, headers });
  if (!isAuthConfigured()) return new Response(AUTH_CONFIGURATION_ERROR, { status: 503, headers });
  const limited = await limitLogin(request);
  if (limited) return limited;
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return new Response("Nieprawidłowe żądanie logowania.", { status: 400, headers });
  }
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("password" in body) ||
        typeof body.password !== "string" || !body.password.trim() || body.password.length > 1024) {
      return new Response("Wpisz hasło.", { status: 400, headers });
    }
    if (!checkPassword(body.password)) return new Response("Nieprawidłowe hasło.", { status: 401, headers });
    return new Response(null, { status: 204, headers: { ...headers, "Set-Cookie": sessionCookie(createSession()) } });
  } catch {
    return new Response("Nieprawidłowe żądanie logowania.", { status: 400, headers });
  }
}
