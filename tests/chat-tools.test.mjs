import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentTime } from "../lib/server/chat-tools.ts";

test("aktualnyCzas uwzględnia warszawską datę i dzień tygodnia po północy", () => {
  assert.deepEqual(getCurrentTime(new Date("2026-11-14T23:30:00Z")), {
    data: "15.11.2026", dzienTygodnia: "niedziela", godzina: "00:30:00", strefa: "Europe/Warsaw",
  });
});

test("aktualnyCzas uwzględnia zmianę czasu letniego i zimowego", () => {
  for (const [instant, expected] of [
    ["2026-03-29T00:59:59Z", "01:59:59"],
    ["2026-03-29T01:00:00Z", "03:00:00"],
    ["2026-10-25T00:30:00Z", "02:30:00"],
    ["2026-10-25T01:30:00Z", "02:30:00"],
  ]) assert.equal(getCurrentTime(new Date(instant)).godzina, expected);
});
