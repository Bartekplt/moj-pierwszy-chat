import { checkRateLimit } from "@vercel/firewall";

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
let localWindow = { startedAt: 0, attempts: 0 };

export async function limitLogin(request: Request): Promise<Response | null> {
  if (process.env.VERCEL !== "1" && (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test")) {
    // Tylko lokalny warsztat. Ten licznik nie chroni wielu instancji hostingu.
    const now = Date.now();
    if (now - localWindow.startedAt >= WINDOW_MS) localWindow = { startedAt: now, attempts: 0 };
    if (localWindow.attempts >= MAX_ATTEMPTS) {
      return new Response("Za dużo prób. Odczekaj minutę i spróbuj ponownie.", {
        status: 429,
        headers: { "Retry-After": String(Math.max(1, Math.ceil((localWindow.startedAt + WINDOW_MS - now) / 1000))), "Cache-Control": "no-store" },
      });
    }
    localWindow.attempts += 1;
    return null;
  }

  // Produkcja: żadnego awaryjnego przejścia na licznik w pamięci procesu.
  // W produkcji techniczny VERCEL_URL może wymagać Vercel Authentication.
  // Wybieramy publiczną domenę projektu, zachowując ochronę wdrożeń preview.
  const environment = process.env.VERCEL_ENV;
  const host = environment === "production"
    ? process.env.VERCEL_PROJECT_PRODUCTION_URL
    : process.env.VERCEL_URL;
  if (process.env.NODE_ENV !== "production" || process.env.VERCEL !== "1" ||
      !["production", "preview"].includes(environment ?? "") ||
      !host || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    return unavailable();
  }
  try {
    const ip = request.headers.get("x-real-ip");
    if (!ip) return unavailable();
    // Host pochodzi z konfiguracji Vercel, a nie z nagłówka podanego przez klienta.
    const result = await checkRateLimit("chat-login", {
      headers: new Headers({ host, "x-real-ip": ip }),
      timeout: 1500,
    });
    if (result.error === "not-found") return unavailable();
    if (result.rateLimited || result.error) {
      return new Response("Za dużo prób. Odczekaj minutę i spróbuj ponownie.", {
        status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" },
      });
    }
    return null;
  } catch {
    return unavailable();
  }
}

function unavailable() {
  return new Response("Logowanie jest zablokowane: skonfiguruj aktywny limit Vercel Firewall o ID chat-login.", {
    status: 503, headers: { "Cache-Control": "no-store" },
  });
}
