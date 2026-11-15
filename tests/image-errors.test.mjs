import assert from "node:assert/strict";
import test from "node:test";
import { APICallError, NoImageGeneratedError } from "ai";
import { generatePicture, validateImagePrompt } from "../lib/server/image-generation.ts";
import { classifyImageError } from "../lib/server/image-errors.ts";
import { imageFailureMessages, publicImageError } from "../lib/image-errors.ts";

test("błędy OpenRouter mają właściwe polskie komunikaty i bezpieczne logi", async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...items) => warnings.push(items);
  try {
    for (const [status, code] of [[400, "configuration"], [401, "authentication"], [402, "credits"],
      [403, "access"], [404, "unavailable"], [429, "rate_limit"], [503, "unavailable"], [504, "timeout"]]) {
      globalThis.fetch = async () => Response.json({ error: { message: "SECRET-UPSTREAM-DETAIL" } }, { status });
      await assert.rejects(generatePicture({ apiKey: "SECRET-TEST-KEY", prompt: "PRIVATE-TEST-PROMPT", signal: new AbortController().signal }),
        (error) => error.code === code && error.httpStatus === status && error.message === imageFailureMessages[code]);
    }
    assert.equal(warnings.length, 8);
    assert.deepEqual(warnings[2][1].code, "credits");
    assert.ok(!JSON.stringify(warnings).includes("SECRET"));
    assert.ok(!JSON.stringify(warnings).includes("PRIVATE-TEST-PROMPT"));
  } finally { console.warn = originalWarn; }
});

test("odmowa, błąd w HTTP 200 i brak obrazu są rozróżniane", async () => {
  for (const [payload, code] of [
    [{ error: { code: 402, message: "SECRET" } }, "credits"],
    [{ choices: [{ message: { refusal: "SECRET" } }] }, "refused"],
    [{ choices: [{ finish_reason: "content_filter", message: {} }] }, "refused"],
    [{ choices: [{ message: { content: "Tekst zamiast obrazu" } }] }, "empty"],
  ]) {
    globalThis.fetch = async () => Response.json(payload);
    await assert.rejects(generatePicture({ apiKey: "test-only-key", prompt: "Kot", signal: new AbortController().signal }),
      (error) => error.code === code && !error.message.includes("SECRET"));
  }
});

test("opakowany błąd SDK zachowuje kod, a przeglądarka nie wyświetla nieznanej treści błędu", () => {
  const failure = classifyImageError(new NoImageGeneratedError({ cause: new APICallError({
    message: "SECRET", url: "https://openrouter.ai/api/v1/chat/completions", requestBodyValues: {}, statusCode: 402,
  }) }));
  assert.equal(failure.code, "credits");
  assert.equal(publicImageError(failure.message), imageFailureMessages.credits);
  assert.equal(publicImageError("SECRET-UPSTREAM-DETAIL"), imageFailureMessages.unknown);
});

test("opis zgłoszonego wnętrza mieści się w limicie narzędzia", () => {
  assert.equal(validateImagePrompt({ prompt: "Wygeneruj wnętrze salonu z kuchnią i jadalnia o powierzchni około 50 m2 o wysokości sufitu około 2,6m w stylu trochę paryskiej kamienicy, trochę mid-century modern a trochę w stylu willi modernistycznych z lat 20" }).success, true);
});
