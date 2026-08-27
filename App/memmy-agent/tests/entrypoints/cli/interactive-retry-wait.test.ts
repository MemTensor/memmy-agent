import { afterEach, describe, expect, it, vi } from "vitest";
import * as commands from "../../../src/entrypoints/cli/commands.js";

const ORIGINAL_NO_COLOR = process.env.NO_COLOR;

function captureStdout(): string[] {
  process.env.NO_COLOR = "1";
  const calls: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    calls.push(String(chunk).trimEnd());
    return true;
  });
  return calls;
}

function captureStdoutRaw(): string[] {
  process.env.NO_COLOR = "1";
  const calls: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    calls.push(String(chunk));
    return true;
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_NO_COLOR == null) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = ORIGINAL_NO_COLOR;
});

describe("interactive progress rendering", () => {
  it("renders retry waits as progress even when progress is disabled", async () => {
    const calls = captureStdout();

    const handled = await commands.maybePrintInteractiveProgress(
      { content: "Model request failed, retry in 2s (attempt 1).", metadata: { retryWait: true } },
      null,
      { sendProgress: false, sendToolHints: false },
    );

    expect(handled).toBe(true);
    expect(calls).toEqual(["Model request failed, retry in 2s (attempt 1)."]);
  });

  it("shows reasoning when showReasoning is enabled", async () => {
    const calls = captureStdout();

    const handled = await commands.maybePrintInteractiveProgress(
      { content: "Let me think about this...", metadata: { agentProgress: true, reasoning: true } },
      null,
      { sendProgress: true, showReasoning: true },
    );

    expect(handled).toBe(true);
    expect(calls).toEqual(["thinking: Let me think about this..."]);
  });

  it("streams reasoning chunks on one line until reasoning end", async () => {
    const calls = captureStdoutRaw();
    const buffer = new commands.ReasoningBuffer();

    const first = await commands.maybePrintInteractiveProgress(
      { content: "The", metadata: { agentProgress: true, reasoning: true } },
      null,
      { showReasoning: true },
      { reasoningBuffer: buffer },
    );
    const second = await commands.maybePrintInteractiveProgress(
      { content: " user is", metadata: { agentProgress: true, reasoning: true } },
      null,
      { showReasoning: true },
      { reasoningBuffer: buffer },
    );
    const end = await commands.maybePrintInteractiveProgress(
      { content: "", metadata: { agentProgress: true, reasoningEnd: true } },
      null,
      { showReasoning: true },
      { reasoningBuffer: buffer },
    );

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(end).toBe(true);
    expect(calls.join("")).toBe("thinking: The user is\n");
    expect(calls.join("").match(/thinking:/g)).toHaveLength(1);
  });

  it("renders reasoning delta frames with the reasoning renderer", async () => {
    const calls = captureStdout();

    const handled = await commands.maybePrintInteractiveProgress(
      { content: "I should search first.", metadata: { agentProgress: true, reasoningDelta: true } },
      null,
      { sendProgress: true, showReasoning: true },
    );

    expect(handled).toBe(true);
    expect(calls).toEqual(["thinking: I should search first."]);
  });

  it("buffers reasoning deltas until a sentence boundary", async () => {
    const calls = captureStdout();
    const buffer = new commands.ReasoningBuffer();

    const first = await commands.maybePrintInteractiveProgress(
      { content: "The", metadata: { agentProgress: true, reasoningDelta: true } },
      null,
      { showReasoning: true },
      { reasoningBuffer: buffer },
    );
    const second = await commands.maybePrintInteractiveProgress(
      { content: " user asked.", metadata: { agentProgress: true, reasoningDelta: true } },
      null,
      { showReasoning: true },
      { reasoningBuffer: buffer },
    );

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(calls).toEqual(["thinking: The user asked."]);
  });

  it("flushes buffered reasoning deltas on reasoning end", async () => {
    const calls = captureStdout();
    const buffer = new commands.ReasoningBuffer();

    const delta = await commands.maybePrintInteractiveProgress(
      { content: "Still buffered", metadata: { agentProgress: true, reasoningDelta: true } },
      null,
      { showReasoning: true },
      { reasoningBuffer: buffer },
    );
    const end = await commands.maybePrintInteractiveProgress(
      { content: "", metadata: { agentProgress: true, reasoningEnd: true } },
      null,
      { showReasoning: true },
      { reasoningBuffer: buffer },
    );

    expect(delta).toBe(true);
    expect(end).toBe(true);
    expect(calls).toEqual(["thinking: Still buffered"]);
  });

  it("hides reasoning when showReasoning is disabled", async () => {
    const calls = captureStdout();

    const handled = await commands.maybePrintInteractiveProgress(
      { content: "Let me think about this...", metadata: { agentProgress: true, reasoning: true } },
      null,
      { sendProgress: true, showReasoning: false },
    );

    expect(handled).toBe(true);
    expect(calls).toEqual([]);
  });

  it("prints non-reasoning progress even when showReasoning is disabled", async () => {
    const calls = captureStdout();

    const handled = await commands.maybePrintInteractiveProgress(
      { content: "working on it...", metadata: { agentProgress: true } },
      null,
      { sendProgress: true, sendToolHints: false, showReasoning: false },
    );

    expect(handled).toBe(true);
    expect(calls).toEqual(["working on it..."]);
  });

  it("shows reasoning even when sendProgress is disabled", async () => {
    const calls = captureStdout();

    const handled = await commands.maybePrintInteractiveProgress(
      { content: "Let me think about this...", metadata: { agentProgress: true, reasoning: true } },
      null,
      { sendProgress: false, sendToolHints: false, showReasoning: true },
    );

    expect(handled).toBe(true);
    expect(calls).toEqual(["thinking: Let me think about this..."]);
  });

  it("formats every reasoning line with a thinking prefix", () => {
    expect(commands.formatCliReasoning("line1\nline2")).toBe("thinking: line1\nthinking: line2");
    expect(commands.formatCliReasoning("   ")).toBe("");
  });

  it("leaves reasoning output plain for non-TTY streams", () => {
    expect(commands.styleCliReasoning("thinking: x", { isTTY: false })).toBe("thinking: x");
  });

  it("styles reasoning output for TTY streams", () => {
    delete process.env.NO_COLOR;

    expect(commands.styleCliReasoning("thinking: x", { isTTY: true })).toBe("\x1b[90;3mthinking: x\x1b[0m");
  });

  it("does not style reasoning output when NO_COLOR is set", () => {
    process.env.NO_COLOR = "";

    expect(commands.styleCliReasoning("thinking: x", { isTTY: true })).toBe("thinking: x");
  });
});
