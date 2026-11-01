import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "workshop_session";
export const SESSION_TTL = 8 * 60 * 60;
export const AUTH_CONFIGURATION_ERROR =
  "Brak konfiguracji ochrony. Uzupełnij CHAT_PASSWORD i SESSION_SECRET (minimum 32 znaki) w .env.local.";

function configuration() {
  const password = process.env.CHAT_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  if (!password?.trim() || !secret || Buffer.byteLength(secret) < 32) return null;
  return { password, secret };
}

export function isAuthConfigured() {
  return configuration() !== null;
}

export function checkPassword(password: string) {
  const config = configuration();
  if (!config) return false;
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(password), digest(config.password));
}

function signature(payload: string) {
  const config = configuration();
  if (!config) throw new Error(AUTH_CONFIGURATION_ERROR);
  // Zmiana hasła lub sekretu unieważnia wcześniejsze sesje.
  const key = createHmac("sha256", config.secret)
    .update("workshop-session-key\0")
    .update(config.password)
    .digest();
  return createHmac("sha256", key).update(`v1.${payload}`).digest("base64url");
}

export function createSession(now = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(JSON.stringify({
    v: 1, iat: now, exp: now + SESSION_TTL, id: randomBytes(16).toString("hex"),
  })).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function verifySession(token: string | undefined, now = Math.floor(Date.now() / 1000)) {
  if (!isAuthConfigured() || !token || token.length > 1024) return false;
  try {
    const [payload, suppliedSignature, extra] = token.split(".");
    if (!payload || !suppliedSignature || extra !== undefined ||
        !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(suppliedSignature)) return false;
    const expected = Buffer.from(signature(payload));
    const supplied = Buffer.from(suppliedSignature);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.v === 1 && typeof session.id === "string" &&
      Number.isInteger(session.iat) && Number.isInteger(session.exp) &&
      session.iat <= now && session.exp > now && session.exp - session.iat === SESSION_TTL;
  } catch {
    return false;
  }
}

export function hasRequestSession(request: Request) {
  const cookies = (request.headers.get("cookie") ?? "").split(";");
  const matches = cookies.map((cookie) => cookie.trim()).filter((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  return matches.length === 1 && verifySession(matches[0].slice(SESSION_COOKIE.length + 1));
}

export function sessionCookie(token: string, remove = false) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${remove ? 0 : SESSION_TTL}` +
    (remove ? "; Expires=Thu, 01 Jan 1970 00:00:00 GMT" : "") +
    (process.env.NODE_ENV === "production" ? "; Secure" : "");
}

export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    const target = new URL(request.url);
    if (!["http:", "https:"].includes(target.protocol)) return false;
    const host = request.headers.get("host");
    // Next.js może użyć wewnętrznego localhost w request.url. Host zachowuje
    // adres docelowy przeglądarki; nie ufamy dowolnym X-Forwarded-Host.
    if (host !== null) {
      if (!host || /[\/\\@?#\s,]/.test(host)) return false;
      return origin === new URL(`${target.protocol}//${host}`).origin;
    }
    return origin === target.origin;
  } catch {
    return false;
  }
}
