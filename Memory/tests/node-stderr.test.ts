import { describe, expect, it } from "vitest";
import { expectNoUnexpectedNodeStderr } from "./fixtures/node-stderr.js";

const warning = "(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time";
const hint = "(Use `node --trace-warnings ...` to show where the warning was created)";

describe("hook stderr assertions", () => {
  it.each(["", warning, `${warning}\n`, `${warning}\n${hint}\n`, `${warning}\r\n${hint}\r\n`])(
    "accepts empty stderr or only the known SQLite warning: %j",
    (stderr) => expectNoUnexpectedNodeStderr(stderr),
  );

  it.each([
    "Error: database is closed\n",
    `${warning}\n${hint}\nError: database is closed\n`,
    `turn_incomplete\n${warning}\n${hint}\n`,
    "(node:123) ExperimentalWarning: Another experimental feature\n",
    `${warning}: unexpected details\n`,
    `${hint}\n`,
  ])("rejects unexpected stderr, including alongside the warning: %j", (stderr) => {
    expect(() => expectNoUnexpectedNodeStderr(stderr)).toThrow();
  });
});
