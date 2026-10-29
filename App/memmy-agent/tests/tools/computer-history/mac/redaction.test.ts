import assert from "node:assert/strict";
import { test } from "vitest";
import { redactSensitive } from "../../../../src/tools/computer-history/mac/redaction.js";
import { scrubAccessibility, scrubAxSnapshot } from "../../../../src/tools/computer-history/mac/record-human-history.js";
import { redactSensitive as redactSummary } from "../../../../src/tools/computer-history/mac/summarize-history.js";

test("redacts JSON credential values while preserving quotes, punctuation and ordinary content", () => {
  const input = JSON.stringify({ password: 'fake phrase, with "quotes"', api_key: "fake-key",
    access_token: "fake-token", authToken: "fake-auth", nested: { secret: "fake secret" }, normal: "keep this" });
  const expected = { password: "[REDACTED]", api_key: "[REDACTED]", access_token: "[REDACTED]",
    authToken: "[REDACTED]", nested: { secret: "[REDACTED]" }, normal: "keep this" };
  assert.deepEqual(JSON.parse(redactSensitive(input)), expected);
  assert.deepEqual(JSON.parse(redactSummary(input)), expected);
  assert.deepEqual(JSON.parse((scrubAccessibility({ value: input }) as { value: string }).value), expected);
  assert.deepEqual(JSON.parse((scrubAxSnapshot({ text: `AXStaticText|||||${input}` }) as { text: string })
    .text.split("|").at(-1)!), expected);
});

test("supports terminal and single-quoted credentials without matching longer ordinary keys", () => {
  assert.equal(redactSensitive("api-key=fake; password='fake phrase, with spaces'; 'secret': 'fake'"),
    "api-key=[REDACTED]; password='[REDACTED]'; 'secret': '[REDACTED]'");
  assert.equal(redactSensitive("passwordless=true api_key_hint=keep"), "passwordless=true api_key_hint=keep");
  const scrubbed = redactSensitive("api-key=fake; password='fake phrase'; \"secret\":\"fake\"");
  assert.equal(redactSensitive(scrubbed), scrubbed);
});
