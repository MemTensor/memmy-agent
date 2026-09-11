import { describe, expect, it } from "vitest";
import {
  parseRootTerminalOptions,
  type RootTerminalOptions,
} from "../../../src/entrypoints/cli/root-terminal-options.js";

const argv = (...args: string[]): string[] => ["node", "memmy", ...args];

describe("parseRootTerminalOptions", () => {
  it.each<[string[], RootTerminalOptions]>([
    [argv(), {}],
    [argv("--standalone"), { standalone: true }],
    [argv("--session", "cli:one"), { sessionId: "cli:one" }],
    [argv("-s", "cli:short"), { sessionId: "cli:short" }],
    [argv("--project", "/tmp/project"), { project: "/tmp/project" }],
  ])("recognizes root terminal arguments: %j", (input, expected) => {
    expect(parseRootTerminalOptions(input)).toEqual(expected);
  });

  it.each([
    [argv("--session"), "--session requires a sessionId"],
    [argv("-s"), "--session requires a sessionId"],
    [argv("--session", "--standalone"), "--session requires a sessionId"],
    [argv("--project"), "--project requires a path"],
    [argv("--project", "--standalone"), "--project requires a path"],
  ])("rejects a missing root option value: %j", (input, message) => {
    expect(() => parseRootTerminalOptions(input)).toThrow(message);
  });

  it.each([
    { input: argv("--standalone", "--session", "cli:one") },
    { input: argv("--standalone", "--project", "/tmp/project") },
    { input: argv("--session", "cli:one", "--project", "/tmp/project") },
  ])("rejects mutually exclusive root terminal options: $input", ({ input }) => {
    expect(() => parseRootTerminalOptions(input)).toThrow(
      "--session, --standalone, and --project are mutually exclusive",
    );
  });

  it.each([
    { input: argv("--help") },
    { input: argv("-h") },
    { input: argv("--version") },
    { input: argv("-V") },
    { input: argv("gateway") },
    { input: argv("onboard", "--defaults") },
  ])("leaves help, version, and subcommands to Commander: $input", ({ input }) => {
    expect(parseRootTerminalOptions(input)).toBeNull();
  });
});
