import assert from "node:assert/strict";
import test from "node:test";
import { isSameOrigin } from "../lib/server/session.ts";

const request = (headers, url = "http://localhost:3000/api/login") => new Request(url, {
  method: "POST", headers,
});

test("lokalny adres przeglądarki działa mimo wewnętrznego localhost w Next.js", () => {
  assert.equal(isSameOrigin(request({
    Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000",
  })), true);
  assert.equal(isSameOrigin(request({
    Host: "localhost:3000", Origin: "http://localhost:3000",
  })), true);
  assert.equal(isSameOrigin(request({
    Host: "[::1]:3000", Origin: "http://[::1]:3000",
  })), true);
});

test("brak Origin, obca domena, port i protokół są odrzucane", () => {
  for (const origin of [null, "null", "https://obca.example", "http://127.0.0.1:3001",
    "https://127.0.0.1:3000", "http://localhost:3000", "http://127.0.0.1:3000.attacker.example",
    "http://127.0.0.1:3000/path"]) {
    const headers = { Host: "127.0.0.1:3000" };
    if (origin !== null) headers.Origin = origin;
    assert.equal(isSameOrigin(request(headers)), false);
  }
});

test("podrobiony forwarded host i nieprawidłowy Host nie omijają kontroli", () => {
  assert.equal(isSameOrigin(request({
    Host: "127.0.0.1:3000", Origin: "https://obca.example",
    "X-Forwarded-Host": "obca.example", "X-Forwarded-Proto": "https",
  })), false);
  for (const host of ["", "localhost:3000@obca.example", "localhost:3000/path",
    "localhost:3000,obca.example", "localhost:3000?x", "localhost:3000#x"]) {
    assert.equal(isSameOrigin(request({ Host: host, Origin: "http://localhost:3000" })), false);
  }
});

test("HTTPS w produkcji i żądania bez nagłówka Host zachowują ścisłe porównanie", () => {
  assert.equal(isSameOrigin(request({ Host: "chat.example", Origin: "https://chat.example" },
    "https://internal.example/api/login")), true);
  assert.equal(isSameOrigin(request({ Origin: "http://localhost:3000" })), true);
  assert.equal(isSameOrigin(request({ Origin: "http://127.0.0.1:3000" })), false);
});
