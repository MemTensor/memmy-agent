import { expect } from "vitest";

// Node 22 emits this diagnostic when a hook imports node:sqlite. Keep all
// other stderr, and include the original output in assertion failures.
export function expectNoUnexpectedNodeStderr(stderr: string): void {
  const unexpected = stderr.replace(
    /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time(?:\r?\n|$)(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)(?:\r?\n|$))?/gm,
    "",
  );
  expect(unexpected, stderr).toBe("");
}
