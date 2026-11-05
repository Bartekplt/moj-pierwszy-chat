import assert from "node:assert/strict";
import test from "node:test";
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { POST } from "../app/api/chat/route.ts";
import { createSession, SESSION_COOKIE } from "../lib/server/session.ts";

// Testy nie wczytują plików .env i nigdy nie korzystają z prawdziwego klucza.
process.env.OPENROUTER_API_KEY = "";
process.env.OPENROUTER_MODEL = "";
process.env.NODE_ENV = "test";
process.env.CHAT_PASSWORD = "test-only-password";
process.env.SESSION_SECRET = "test-only-session-secret-with-at-least-32-characters";
globalThis.fetch = async () => { throw new Error("Połączenia sieciowe są zabronione w testach"); };

const authHeaders = () => ({
  "Content-Type": "application/json", "Origin": "http://localhost",
  "Cookie": `${SESSION_COOKIE}=${createSession()}`,
});

const userMessage = (text) => ({ id: "user-1", role: "user", parts: [{ type: "text", text }] });
const request = (messages) => new Request("http://localhost/api/chat", {
  method: "POST",
  headers: authHeaders(),
  body: JSON.stringify({ messages }),
});
const chunk = (text, finish = null) => `data: ${JSON.stringify({
  id: "test-response", model: "test/model", created: 0,
  choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
})}\n\n`;

test("walidacja, brak konfiguracji, strumieniowanie i historia bez wywołań API", async (t) => {
  await t.test("odrzuca błędne dane i puste wiadomości", async () => {
    for (const messages of [null, [], [userMessage("   ")], [{ role: "user" }]]) {
      assert.equal((await POST(request(messages))).status, 400);
    }
    assert.equal((await POST(new Request("http://localhost/api/chat", {
      method: "POST", headers: authHeaders(), body: "nie jest JSON-em",
    }))).status, 400);
  });

  await t.test("zwraca czytelny błąd konfiguracji przed połączeniem z dostawcą", async () => {
    const response = await POST(request([userMessage("Cześć")]));
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.match(text, /OPENROUTER_API_KEY/);
    assert.match(text, /OPENROUTER_MODEL/);
    assert.match(text, /\.env.local/);
  });

  process.env.OPENROUTER_API_KEY = "test-only-dummy-key";
  process.env.OPENROUTER_MODEL = "test/model";

  await t.test("przesyła pierwszy fragment przed zakończeniem odpowiedzi", async () => {
    const encoder = new TextEncoder();
    let upstream;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        upstream = controller;
        controller.enqueue(encoder.encode(chunk("Cześć")));
      },
    }), { headers: { "Content-Type": "text/event-stream" } });

    const response = await POST(request([userMessage("Hej")]));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    try {
      while (!received.includes('"type":"text-delta"')) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        received += decoder.decode(value);
      }
      assert.match(received, /Cześć/);
      assert.ok(!received.includes("[DONE]"));
    } finally {
      upstream.enqueue(encoder.encode(chunk("", "stop") + "data: [DONE]\n\n"));
      upstream.close();
    }
    while (!(await reader.read()).done) { /* Odbierz zakończenie strumienia. */ }
  });

  await t.test("useChat transport przesyła wcześniejsze wiadomości obu stron", async () => {
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response(chunk("Pamiętam.") + chunk("", "stop") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    const chat = new Chat({ transport: new DefaultChatTransport({
      fetch: async (_url, options) => POST(new Request("http://localhost/api/chat", {
        ...options, headers: { ...Object.fromEntries(new Headers(options.headers)), ...authHeaders() },
      })),
    }) });
    await chat.sendMessage({ text: "Mam na imię Ola." });
    assert.equal(chat.status, "ready");
    await chat.sendMessage({ text: "Jak mam na imię?" });
    assert.equal(chat.status, "ready");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].messages.map(({ role }) => role), ["system", "user"]);
    assert.deepEqual(calls[1].messages.map(({ role }) => role), ["system", "user", "assistant", "user"]);
    assert.deepEqual(calls[0].messages[0].content, calls[1].messages[0].content);
    const instructions = calls[1].messages[0].content.map(({ text }) => text).join("");
    assert.match(instructions, /Jesteś asystentem Studio Nova/);
    assert.match(instructions, /45 minut.*150 zł brutto/);
    assert.equal(calls[0].messages[1].content, "Mam na imię Ola.");
    assert.match(JSON.stringify(calls[1].messages), /Mam na imię Ola/);
    assert.match(JSON.stringify(calls[1].messages), /Pamiętam/);
    assert.equal(calls[1].model, "test/model");
  });

  await t.test("błąd dostawcy nie ujawnia jego szczegółów", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: "SECRET-UPSTREAM-DETAIL", code: 401 },
    }), { status: 401, headers: { "Content-Type": "application/json" } });
    const response = await POST(request([userMessage("Hej")]));
    const text = await response.text();
    assert.match(text, /Nie udało się uzyskać odpowiedzi/);
    assert.ok(!text.includes("SECRET-UPSTREAM-DETAIL"));
    assert.ok(!text.includes("test-only-dummy-key"));
  });
});
