import { isSameOrigin, sessionCookie } from "../../../lib/server/session.ts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return new Response("Niedozwolone pochodzenie żądania.", { status: 403 });
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": sessionCookie("", true), "Cache-Control": "no-store" },
  });
}
