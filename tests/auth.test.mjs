import assert from "node:assert/strict";
import test from "node:test";
import { POST as login } from "../app/api/login/route.ts";
import { POST as logout } from "../app/api/logout/route.ts";
import { POST as chat } from "../app/api/chat/route.ts";
import { createSession, verifySession, SESSION_COOKIE, SESSION_TTL } from "../lib/server/session.ts";

// Wyłącznie wartości testowe; bez wczytywania .env i bez prawdziwej sieci.
process.env.NODE_ENV = "test";
process.env.VERCEL = "";
process.env.CHAT_PASSWORD = "";
process.env.SESSION_SECRET = "";
process.env.OPENROUTER_API_KEY = "test-only-key";
process.env.OPENROUTER_MODEL = "test/model";
const password = "test-only-workshop-password";
const secret = "test-only-secret-with-at-least-32-characters";
let modelCalls = 0;
globalThis.fetch = async () => {
  modelCalls += 1;
  throw new Error("Żadnych połączeń z modelem w testach ochrony");
};

const makeRequest = (path, body, headers = {}) => new Request(`http://localhost${path}`, {
  method: "POST", body: JSON.stringify(body),
  headers: { "Content-Type": "application/json", Origin: "http://localhost", "x-real-ip": "203.0.113.5", ...headers },
});
const loginRequest = (value = password, headers = {}) => makeRequest("/api/login", { password: value }, headers);
const chatRequest = (cookie = "") => makeRequest("/api/chat", {
  messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Cześć" }] }],
}, { Cookie: cookie });
const cookieFor = (token) => `${SESSION_COOKIE}=${token}`;

test("ochrona warsztatowego czatu", async (t) => {
  let cookie;

  await t.test("brak konfiguracji blokuje logowanie i czat", async () => {
    assert.equal((await login(loginRequest())).status, 503);
    assert.equal((await chat(chatRequest())).status, 401);
  });
  process.env.CHAT_PASSWORD = password;
  process.env.SESSION_SECRET = secret;

  await t.test("błędne i puste hasło nie tworzą sesji", async () => {
    const wrong = await login(loginRequest("błędne"));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("set-cookie"), null);
    assert.equal((await login(loginRequest("   "))).status, 400);
  });

  await t.test("poprawne hasło tworzy podpisane cookie bez hasła", async () => {
    const response = await login(loginRequest());
    assert.equal(response.status, 204);
    const header = response.headers.get("set-cookie");
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Strict/);
    assert.match(header, new RegExp(`Max-Age=${SESSION_TTL}`));
    assert.ok(!header.includes("Secure"));
    cookie = header.split(";")[0];
    const token = cookie.slice(SESSION_COOKIE.length + 1);
    assert.ok(verifySession(token));
    const payload = Buffer.from(token.split(".")[0], "base64url").toString("utf8");
    assert.ok(!payload.includes(password));
    assert.ok(!payload.includes(secret));
  });

  await t.test("brak sesji, fałszerstwo i wygaśnięcie dają 401 przed wywołaniem modelu", async () => {
    const token = createSession();
    const now = Math.floor(Date.now() / 1000);
    for (const invalidCookie of ["", cookieFor("fake-session"), cookieFor(`${token.slice(0, -1)}!`),
      cookieFor(createSession(now - SESSION_TTL))]) {
      assert.equal((await chat(chatRequest(invalidCookie))).status, 401);
    }
    // Poprawna sesja przechodzi kontrolę dostępu; błędne body zatrzymuje ją przed modelem.
    assert.equal((await chat(makeRequest("/api/chat", { messages: [] }, { Cookie: cookie }))).status, 400);
    assert.equal(verifySession(token, now + SESSION_TTL), false);
    process.env.CHAT_PASSWORD = "changed-password";
    assert.equal(verifySession(token), false);
    process.env.CHAT_PASSWORD = password;
    process.env.SESSION_SECRET = "short";
    assert.equal(verifySession(token), false);
    assert.equal((await login(loginRequest())).status, 503);
    process.env.SESSION_SECRET = secret;
  });

  await t.test("obce pochodzenie nie pozwala logować, wylogować ani korzystać z czatu", async () => {
    const foreign = { Origin: "https://obca-strona.example", Cookie: cookie };
    assert.equal((await login(loginRequest(password, foreign))).status, 403);
    assert.equal((await logout(makeRequest("/api/logout", {}, foreign))).status, 403);
    assert.equal((await chat(makeRequest("/api/chat", {}, foreign))).status, 403);
  });

  await t.test("wyjście usuwa cookie; po jego usunięciu czat odmawia dostępu", async () => {
    const response = await logout(makeRequest("/api/logout", {}, { Cookie: cookie }));
    assert.equal(response.status, 204);
    assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
    const clearedCookie = response.headers.get("set-cookie").split(";")[0];
    assert.equal((await chat(chatRequest(clearedCookie))).status, 401);
  });

  await t.test("szósta lokalna próba jest blokowana nawet z poprawnym hasłem", async () => {
    assert.equal((await login(loginRequest("wrong-4"))).status, 401);
    assert.equal((await login(loginRequest("wrong-5"))).status, 401);
    const limited = await login(loginRequest());
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal(limited.headers.get("set-cookie"), null);
    assert.equal(modelCalls, 0, "Żadna próba ochrony nie może wywołać modelu");
  });

  await t.test("produkcja blokuje logowanie bez zewnętrznego limitera", async () => {
    process.env.NODE_ENV = "production";
    assert.equal((await login(loginRequest())).status, 503);
    process.env.VERCEL = "1";
    process.env.VERCEL_URL = "workshop.vercel.app";
    globalThis.fetch = async () => new Response(null, { status: 404 });
    assert.equal((await login(loginRequest())).status, 503);
    globalThis.fetch = async () => { throw new Error("Firewall unavailable"); };
    assert.equal((await login(loginRequest())).status, 503);
  });

  await t.test("aktywny Firewall dopuszcza sesję z Secure, blokada nie tworzy sesji", async () => {
    globalThis.fetch = async (url) => {
      assert.match(String(url), /^https:\/\/workshop\.vercel\.app\//);
      return new Response(null, { status: 204 });
    };
    const allowed = await login(loginRequest(password, { Host: "localhost", "x-forwarded-host": "attacker.example" }));
    assert.equal(allowed.status, 204);
    assert.match(allowed.headers.get("set-cookie"), /; Secure/);
    globalThis.fetch = async () => new Response(null, { status: 429 });
    const limited = await login(loginRequest());
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("set-cookie"), null);
    process.env.NODE_ENV = "test";
    process.env.VERCEL = "";
  });
});
