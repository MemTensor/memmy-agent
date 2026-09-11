#!/usr/bin/env node

const args = process.argv.slice(2);
const expectedOutputCount = Number(args[3]);
const validOutputFormats = new Set(["docx"]);
const valid =
  args.length === 6 &&
  args[0] === "--operation-kind" &&
  new Set(["create", "edit"]).has(args[1]) &&
  args[2] === "--expected-output-count" &&
  Number.isSafeInteger(expectedOutputCount) &&
  expectedOutputCount >= 1 &&
  expectedOutputCount <= 100 &&
  args[4] === "--output-format" &&
  validOutputFormats.has(args[5].toLowerCase());

if (!valid) {
  console.error(
    "usage: mark_artifact_operation_started.mjs --operation-kind <create|edit> --expected-output-count <1-100> --output-format <supported format>",
  );
  process.exitCode = 2;
}
