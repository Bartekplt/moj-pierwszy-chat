import assert from "node:assert/strict";
import test from "node:test";
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { POST as chat } from "../app/api/agent/route.ts";
import { createSession, SESSION_COOKIE } from "../lib/server/session.ts";
import { MAX_IMAGE_BYTES } from "../lib/images.ts";

// Wyłącznie dane testowe, bez .env i bez prawdziwych wywołań OpenRouter.
process.env.NODE_ENV = "test";
process.env.CHAT_PASSWORD = "test-only-password";
process.env.SESSION_SECRET = "test-only-session-secret-with-at-least-32-characters";
process.env.OPENROUTER_API_KEY = "test-only-key";
process.env.OPENROUTER_MODEL = "test/requested-model";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const photo = { type: "file", mediaType: "image/png", filename: "test.png", url: `data:image/png;base64,${png}` };
const headers = () => ({ "Content-Type": "application/json", Origin: "http://localhost", Cookie: `${SESSION_COOKIE}=${createSession()}` });
const request = (path, body, extraHeaders = {}) => new Request(`http://localhost${path}`, {
  method: "POST", headers: { ...headers(), ...extraHeaders }, body: JSON.stringify(body),
});
const visionRequest = (parts) => request("/api/agent", { mode: "chat", messages: [{ id: "u", role: "user", parts }] });
const textPart = { type: "text", text: "Co jest na zdjęciu?" };
const sse = (model) => ["Opis zdjęcia.", ""].map((text, i) => `data: ${JSON.stringify({
  id: "vision-response", ...(model ? { model } : {}), created: 0,
  choices: [{ index: 0, delta: { content: text }, finish_reason: i ? "stop" : null }],
})}\n\n`).join("") + "data: [DONE]\n\n";

test("vision: pliki, historia i identyfikator modelu", async (t) => {
  await t.test("nieprawidłowe typy, zdalne URL, podróbki i ponad 4 MB nie trafiają do modelu", async () => {
    globalThis.fetch = async () => assert.fail("Nieprawidłowy plik nie może uruchomić sieci");
    const large = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    Buffer.from(png, "base64").copy(large);
    for (const file of [
      { ...photo, mediaType: "image/svg+xml" },
      { ...photo, url: "http://127.0.0.1/private" },
      { ...photo, url: "data:image/png;base64,dGVzdA==" },
      { ...photo, url: `data:image/png;base64,${large.toString("base64")}` },
    ]) assert.equal((await chat(visionRequest([textPart, file]))).status, 400);
    assert.equal((await chat(visionRequest([textPart, photo, photo]))).status, 400);
    const req = new Request("http://localhost/api/agent", { method: "POST", body: JSON.stringify({ messages: [] }) });
    assert.equal((await chat(req)).status, 401);
  });
  await t.test("file z useChat dociera do modelu, pozostaje w historii i wraca model użyty przez API", async () => {
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response(sse("test/actual-vision-model"), { headers: { "Content-Type": "text/event-stream" } });
    };
    const client = new Chat({ transport: new DefaultChatTransport({ body: { mode: "chat" },
      fetch: async (_url, options) => chat(new Request("http://localhost/api/agent", { ...options, headers: headers() })),
    }) });
    await client.sendMessage({ text: "Opisz zdjęcie", files: [photo] });
    assert.equal(client.status, "ready");
    assert.ok(client.messages[0].parts.some((part) => part.type === "file" && part.url === photo.url));
    assert.ok(calls[0].messages[1].content.some((part) => part.type === "image_url" && part.image_url.url === photo.url));
    assert.equal(client.messages.at(-1).metadata.modelId, "test/actual-vision-model");
    assert.equal(client.messages.at(-1).metadata.vision, true);
    await client.sendMessage({ text: "A jaki jest kolor?" });
    assert.equal(client.status, "ready");
    assert.equal(calls.length, 2);
    assert.ok(JSON.stringify(calls[1].messages).includes(photo.url));
  });
  await t.test("brak identyfikatora modelu i błąd vision są obsłużone bez zgadywania", async () => {
    globalThis.fetch = async () => new Response(sse(), { headers: { "Content-Type": "text/event-stream" } });
    const stream = await (await chat(visionRequest([photo]))).text();
    assert.match(stream, /"modelId":null/);
    assert.ok(!stream.includes('"modelId":"test/requested-model"'));
    globalThis.fetch = async () => Response.json({ error: { message: "SECRET-VISION-ERROR" } }, { status: 400 });
    const error = await (await chat(visionRequest([textPart, photo]))).text();
    assert.match(error, /Nie udało się przeanalizować zdjęcia/);
    assert.ok(!error.includes("SECRET-VISION-ERROR"));
  });
});
