import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:process", async () => {
  const { PassThrough } = await import("node:stream");
  return { stdout: new PassThrough(), stderr: new PassThrough() };
});
vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("electron-log/main", () => ({
  default: {
    initialize: vi.fn(),
    transports: { file: { level: "info" }, console: { level: "info" } }
  }
}));
vi.mock("../src/main/log-level.js", () => ({
  DEFAULT_LOG_LEVEL: "info",
  parseLogLevel: (level: string) => level,
  readPersistedLogLevel: () => "info",
  writePersistedLogLevel: vi.fn()
}));

beforeEach(() => vi.resetModules());

async function setup() {
  const { stdout, stderr } = await import("node:process");
  stdout.removeAllListeners();
  stderr.removeAllListeners();
  const { default: log } = await import("electron-log/main");
  const logger = await import("../src/main/logger.js");
  logger.initLogger();
  return { stdout, stderr, log, ...logger };
}

describe("desktop console pipe failures", () => {
  it.each(["stdout", "stderr"] as const)("survives %s EPIPE while retaining file logging", async (streamName) => {
    const context = await setup();
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => context[streamName].emit("error", error)).not.toThrow();
    expect(context.log.transports.console.level).toBe(false);
    expect(context.log.transports.file.level).toBe("info");
    context.applyLogLevel("debug");
    expect(context.log.transports.console.level).toBe(false);
    expect(context.log.transports.file.level).toBe("debug");
    expect(() => context[streamName].emit("error", error)).not.toThrow();
  });

  it("does not suppress unrelated stream failures", async () => {
    const { stdout } = await setup();
    const error = Object.assign(new Error("I/O failure"), { code: "EIO" });
    expect(() => stdout.emit("error", error)).toThrow(error);
  });

  it("does not install duplicate handlers or revive a broken console on reinitialization", async () => {
    const context = await setup();
    context.initLogger();
    expect(context.stdout.listenerCount("error")).toBe(1);
    expect(context.stderr.listenerCount("error")).toBe(1);
    context.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    context.initLogger();
    expect(context.log.transports.console.level).toBe(false);
  });
});
