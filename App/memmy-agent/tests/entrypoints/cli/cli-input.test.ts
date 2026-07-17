import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as commands from "../../../src/entrypoints/cli/commands.js";
import * as streamMod from "../../../src/entrypoints/cli/stream.js";
import { StreamRenderer, ThinkingSpinner } from "../../../src/entrypoints/cli/stream.js";
import { getCliHistoryPath } from "../../../src/config/paths.js";

const roots: string[] = [];
const originalWorkspace = process.env.MEMMY_AGENT_WORKSPACE;
const originalIsTTY = (process.stdout as any).isTTY;

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-cli-input-"));
  roots.push(root);
  return root;
}

function mockConsole() {
  const order: string[] = [];
  const spinner = {
    start: vi.fn(() => order.push("start")),
    stop: vi.fn(() => order.push("stop")),
  };
  return {
    order,
    file: { isatty: () => true, write: vi.fn((text: string) => order.push(text)) },
    status: vi.fn(() => spinner),
    print: vi.fn(() => order.push("print")),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  commands.setPromptSessionForTest(null);
  if (originalWorkspace === undefined) delete process.env.MEMMY_AGENT_WORKSPACE;
  else process.env.MEMMY_AGENT_WORKSPACE = originalWorkspace;
  (process.stdout as any).isTTY = originalIsTTY;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CLI input and streaming output", () => {
  it("readInteractiveInputAsync returns prompt session input", async () => {
    const promptAsync = vi.fn(async (prompt: any) => {
      void prompt;
      return "hello world";
    });
    commands.setPromptSessionForTest({ promptAsync: promptAsync });

    await expect(commands.readInteractiveInputAsync()).resolves.toBe("hello world");

    expect(promptAsync).toHaveBeenCalledOnce();
    expect(promptAsync.mock.calls[0][0]).toEqual({ html: "<b fg='ansiblue'>You:</b> " });
  });

  it("readInteractiveInputAsync converts EOF to KeyboardInterrupt", async () => {
    const eof = new Error("eof");
    eof.name = "EOFError";
    commands.setPromptSessionForTest({ promptAsync: vi.fn(async () => { throw eof; }) });

    await expect(commands.readInteractiveInputAsync()).rejects.toMatchObject({ name: "KeyboardInterrupt" });
  });

  it("initPromptSession creates a single-line prompt session with file history", () => {
    const root = tmpRoot();
    process.env.MEMMY_AGENT_WORKSPACE = root;

    const history = commands.initPromptSession();

    expect(history.path).toBe(getCliHistoryPath());
    expect(commands.promptSession.multiline).toBe(false);
    expect(commands.promptSession.enableOpenInEditor).toBe(false);
  });

  it("promptToPlainText normalizes prompt-toolkit style HTML prompts for Node readline", () => {
    expect(commands.promptToPlainText({ html: "<b fg='ansiblue'>You:</b> " })).toBe("You: ");
    expect(commands.promptToPlainText("Plain: ")).toBe("Plain: ");
    expect(commands.promptToPlainText(null)).toBe("> ");
  });

  it("thinking spinner pause stops and restarts", () => {
    const console = mockConsole();
    const thinking = new ThinkingSpinner({ console });

    thinking.start();
    thinking.pause()[Symbol.dispose]();
    thinking.stop();

    expect(console.order).toEqual(["start", "\r\x1b[2K", "stop", "start", "\r\x1b[2K", "stop"]);
  });

  it("CLI progress lines pause the spinner before printing", () => {
    const console = mockConsole();
    const thinking = new ThinkingSpinner({ console });
    const log = vi.spyOn(global.console, "log").mockImplementation(() => {
      console.order.push("print");
    });

    thinking.start();
    commands.printCliProgressLine("tool running", thinking);
    thinking.stop();

    expect(log).toHaveBeenCalledWith("tool running");
    expect(console.order).toEqual(["start", "\r\x1b[2K", "stop", "print", "start", "\r\x1b[2K", "stop"]);
  });

  it("thinking spinner clears the status line when paused", () => {
    const console = mockConsole();
    const thinking = new ThinkingSpinner({ console });

    thinking.start();
    thinking.pause()[Symbol.dispose]();

    expect(console.order).toContain("\r\x1b[2K");
  });

  it("stream renderer stops spinner even after the header was printed", () => {
    const console = mockConsole();
    const renderer = new StreamRenderer({ showSpinner: true, console });
    renderer.headerPrinted = true;

    renderer.ensureHeader();

    expect(console.order).toContain("stop");
    expect(console.order).toContain("\r\x1b[2K");
  });

  it("CLI progress lines open the renderer header before trace output", () => {
    const order: string[] = [];
    const renderer = {
      console: { print: vi.fn(() => order.push("print")) },
      ensureHeader: vi.fn(() => order.push("header")),
      ensureLineBreak: vi.fn(() => order.push("line")),
      pauseSpinner: () => ({ [Symbol.dispose]: () => undefined }),
      live: null,
    } as unknown as StreamRenderer;

    commands.printCliProgressLine("tool running", null, renderer);

    expect(order).toEqual(["header", "line", "print"]);
  });

  it("CLI progress lines stop live frames before trace output", () => {
    const live = { stop: vi.fn() };
    const renderer = new StreamRenderer({ showSpinner: false, console: mockConsole() });
    renderer.live = live;

    commands.printCliProgressLine("tool running", null, renderer);

    expect(live.stop).toHaveBeenCalledOnce();
    expect(renderer.live).toBeNull();
  });

  it("interactive progress lines pause the spinner before printing", async () => {
    const console = mockConsole();
    const thinking = new ThinkingSpinner({ console });
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((text: string) => {
      written.push(text);
      console.order.push("print");
      return true;
    }) as any);

    thinking.start();
    await commands.printInteractiveProgressLine("tool running", thinking);
    thinking.stop();

    expect(written).toEqual(["tool running\n"]);
    expect(console.order).toEqual(["start", "\r\x1b[2K", "stop", "print", "start", "\r\x1b[2K", "stop"]);
  });

  it("response renderable uses text for explicit plain rendering", () => {
    const renderable = commands.responseRenderable("**bold**", true, { renderAs: "text" });

    expect(renderable.constructor.name).toBe("Text");
  });

  it("response renderable preserves normal markdown rendering", () => {
    const renderable = commands.responseRenderable("**bold**", true);

    expect(renderable.constructor.name).toBe("Markdown");
  });

  it("response renderable without metadata keeps markdown path", () => {
    const renderable = commands.responseRenderable("memmy commands:\n/status", true);

    expect(renderable.constructor.name).toBe("Markdown");
  });

  it("stream renderer stopForInput stops the active spinner", () => {
    const console = mockConsole();
    const renderer = new StreamRenderer({ showSpinner: true, console });

    renderer.stopForInput();

    expect(console.order).toContain("stop");
  });

  it("stream renderer writes deltas immediately and onEnd only adds a newline", async () => {
    const console = mockConsole();
    const renderer = new StreamRenderer({ showSpinner: true, console });

    renderer.write("Hel");
    renderer.write("lo");
    await renderer.onEnd();

    expect(console.order).toEqual(["start", "\r\x1b[2K", "stop", "print", "Hel", "lo", "\n"]);
  });

  it("onEnd stops live without reprinting streamed content", async () => {
    const live = { stop: vi.fn() };
    const console = mockConsole();
    const renderer = new StreamRenderer({ showSpinner: false, console });
    renderer.live = live;
    renderer.write("final output");

    await renderer.onEnd();

    expect(live.stop).toHaveBeenCalledOnce();
    expect(renderer.live).toBeNull();
    expect(console.order).toEqual(["print", "final output", "\n"]);
  });

  it("onEnd resuming clears the buffer and restarts spinner", async () => {
    const console = mockConsole();
    const renderer = new StreamRenderer({ showSpinner: true, console });
    renderer.write("some content");

    await renderer.onEnd({ resuming: true });

    expect(renderer.buffer).toBe("");
    expect(console.order.filter((item) => item === "start")).toHaveLength(2);
  });

  it("stream makeConsole forces terminal when stdout is a TTY", () => {
    (process.stdout as any).isTTY = true;

    expect(streamMod.makeConsole().forceTerminal).toBe(true);
  });

  it("stream makeConsole does not force terminal when stdout is not a TTY", () => {
    (process.stdout as any).isTTY = false;

    expect(streamMod.makeConsole().forceTerminal).toBe(false);
  });

  it("renderInteractiveAnsi forceTerminal follows stdout isTTY", () => {
    const captured: boolean[] = [];

    (process.stdout as any).isTTY = true;
    commands.renderInteractiveAnsi((target: any) => {
      captured.push(target.forceTerminal);
    });
    (process.stdout as any).isTTY = false;
    commands.renderInteractiveAnsi((target: any) => {
      captured.push(target.forceTerminal);
    });

    expect(captured).toEqual([true, false]);
  });
});
