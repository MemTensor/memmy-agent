import assert from "node:assert/strict";
import test from "node:test";
import { parsePackFilename } from "./npm-pack-metadata.mjs";

const parse = (value) => parsePackFilename(JSON.stringify(value), "/packages/example");

test("accepts npm 11 arrays and retains the last entry", () => {
  assert.equal(parse([{ filename: "example.tgz" }]), "example.tgz");
  assert.equal(parse([{ filename: "first.tgz" }, { filename: "last.tgz" }]), "last.tgz");
});

test("accepts npm 12 objects keyed by package name", () => {
  assert.equal(parse({ "@memmy/local-api-contracts": { filename: "contracts.tgz" } }), "contracts.tgz");
  assert.equal(parse({ first: { filename: "first.tgz" }, last: { filename: "last.tgz" } }), "last.tgz");
});

test("also accepts a standalone metadata object", () => {
  assert.equal(parse({ filename: "example.tgz" }), "example.tgz");
});

test("rejects missing or invalid filenames with package and raw output context", () => {
  for (const value of [null, false, 1, "text", [], {}, { error: "failed" }, { filename: "" },
    { filename: 42 }, [{ filename: "" }], { example: { filename: 42 } }]) {
    assert.throws(() => parse(value), (error) => {
      assert.ok(error.message.includes("npm pack did not return a filename for /packages/example"));
      assert.ok(error.message.includes(`stdout: ${JSON.stringify(value)}`));
      return true;
    });
  }
});

test("rejects malformed JSON", () => {
  assert.throws(() => parsePackFilename("not json", "/packages/example"), SyntaxError);
});
