import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dream, MemoryStore } from "../../../src/core/agent-runtime/memory.js";
import { LineAge } from "../../../src/utils/gitstore.js";

const roots: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-dream-"));
  roots.push(dir);
  return dir;
}

function makeStore(): MemoryStore {
  const store = new MemoryStore(workspace());
  store.writeSoul("# Soul\n- Helpful");
  store.writeUser("# User\n- Developer");
  store.writeMemory("# Memory\n- Project X active");
  return store;
}

function provider(content = "New fact"): any {
  return {
    chatWithRetry: vi.fn(async () => ({ content, finishReason: "stop", finish_reason: "stop" })),
  };
}

function runResult(stopReason = "completed", toolEvents: Record<string, any>[] = []) {
  return {
    stopReason,
    toolEvents,
    messages: [],
    usage: {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Dream run", () => {
  it("does nothing when there is no unprocessed history", async () => {
    const store = makeStore();
    const p = provider();
    const dream = new Dream({ store, provider: p, model: "test-model", maxBatchSize: 5 });
    const runner = { run: vi.fn() };
    (dream as any).runner = runner;

    expect(await dream.run()).toBe(false);
    expect(p.chatWithRetry).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("calls phase 1 and phase 2 runner with expected AgentRunSpec settings", async () => {
    const store = makeStore();
    store.appendHistory("User prefers dark mode");
    const p = provider("[FILE] dark mode preference");
    const dream = new Dream({ store, provider: p, model: "test-model", maxBatchSize: 5 });
    const runner = { run: vi.fn(async () => runResult("completed", [{ name: "edit_file", status: "ok", detail: "memory/MEMORY.md" }])) };
    (dream as any).runner = runner;

    expect(await dream.run()).toBe(true);

    expect(p.chatWithRetry).toHaveBeenCalledOnce();
    expect(runner.run).toHaveBeenCalledOnce();
    const spec = (runner.run as any).mock.calls[0][0];
    expect(spec.maxIterations).toBe(10);
    expect(spec.failOnToolError).toBe(false);
    const phase1System = p.chatWithRetry.mock.calls[0][0].messages[0].content;
    const phase2System = spec.initialMessages[0].content;
    expect(phase1System).toContain("Extract new facts from the conversation history");
    expect(phase1System).toContain("Deduplicate existing memory files");
    expect(phase1System).toContain("N>14");
    expect(phase1System).not.toContain("{{ staleThresholdDays }}");
    expect(phase2System).toContain("Update memory files based on the following analysis");
    expect(phase2System).toContain(path.join(process.cwd(), "src", "skills", "skill-creator", "SKILL.md"));
    expect(phase2System).not.toContain("{{ skillCreatorPath }}");
    expect(spec.initialMessages[1].content).toContain("[FILE] dark mode preference");
  });

  it("consumes tagged sessions and legacy rows through the same global cursor", async () => {
    const store = makeStore();
    store.appendHistory("legacy event");
    store.appendHistory("wonton session event", { sessionKey: "websocket:chat-1" });
    store.appendHistory("city session event", { sessionKey: "websocket:chat-2" });
    store.appendHistory("cron event", { sessionKey: "cron:job-1" });
    const p = provider("[SKIP]");
    const dream = new Dream({ store, provider: p, model: "test-model", maxBatchSize: 10 });
    (dream as any).runner = { run: vi.fn(async () => runResult("completed")) };

    await dream.run();

    const historyPrompt = p.chatWithRetry.mock.calls[0][0].messages[1].content;
    expect(historyPrompt).toContain("legacy event");
    expect(historyPrompt).toContain("wonton session event");
    expect(historyPrompt).toContain("city session event");
    expect(historyPrompt).toContain("cron event");
    expect(store.getLastDreamCursor()).toBe(4);
  });

  it("advances dream cursor only after completed runner result and compacts history", async () => {
    const store = new MemoryStore(workspace(), 2);
    store.appendHistory("event 1");
    store.appendHistory("event 2");
    store.appendHistory("event 3");
    const p = provider("[SKIP]");
    const dream = new Dream({ store, provider: p, model: "test-model", maxBatchSize: 5 });
    (dream as any).runner = { run: vi.fn(async () => runResult("completed")) };

    await dream.run();

    expect(store.getLastDreamCursor()).toBe(3);
    expect(store.readUnprocessedHistory(0).map((entry) => entry.cursor)).toEqual([2, 3]);

    const retryStore = makeStore();
    retryStore.appendHistory("event 1");
    const retryDream = new Dream({ store: retryStore, provider: p, model: "test-model" });
    (retryDream as any).runner = { run: vi.fn(async () => runResult("maxIterations")) };

    await retryDream.run();

    expect(retryStore.getLastDreamCursor()).toBe(0);
  });

  it("builds phase 1 prompt with current files, stale line ages only for MEMORY.md, and input caps", async () => {
    const store = makeStore();
    store.writeMemory("# Memory\n- Project X active\n- fresh item\n- edge case line");
    store.appendHistory("H".repeat(40_000));
    const p = provider("[SKIP]");
    const dream = new Dream({ store, provider: p, model: "test-model" });
    (dream as any).runner = { run: vi.fn(async () => runResult("completed")) };
    vi.spyOn(store.git, "lineAges").mockReturnValue([
      new LineAge(30),
      new LineAge(20),
      new LineAge(14),
      new LineAge(5),
    ]);

    await dream.run();

    const messages = p.chatWithRetry.mock.calls[0][0].messages;
    const system = messages[0].content;
    const user = messages[1].content;
    const memorySection = user.split("## Current MEMORY.md")[1].split("## Current SOUL.md")[0];
    const soulSection = user.split("## Current SOUL.md")[1].split("## Current USER.md")[0];

    expect(system).toContain("N>14");
    expect(memorySection).toContain("← 30d");
    expect(memorySection).toContain("← 20d");
    expect(memorySection).not.toContain("← 14d");
    expect(soulSection).not.toContain("←");
    expect(user.split("## Conversation History\n")[1].split("\n\n## Current Date")[0].length).toBeLessThan(
      dream.historyEntryPreviewMaxChars + 500,
    );
  });

  it("skips line-age annotation when disabled or when blame line counts mismatch", async () => {
    const store = makeStore();
    store.appendHistory("some event");
    const p = provider("[SKIP]");
    const dream = new Dream({ store, provider: p, model: "test-model" });
    dream.annotateLineAges = false;
    const runner = { run: vi.fn(async () => runResult("completed")) };
    (dream as any).runner = runner;
    const ageSpy = vi.spyOn(store.git, "lineAges");

    await dream.run();

    expect(ageSpy).not.toHaveBeenCalled();
    expect(p.chatWithRetry.mock.calls[0][0].messages[1].content).not.toContain("←");

    const mismatchStore = makeStore();
    mismatchStore.appendHistory("some event");
    const mismatchProvider = provider("[SKIP]");
    const mismatchDream = new Dream({ store: mismatchStore, provider: mismatchProvider, model: "test-model" });
    (mismatchDream as any).runner = runner;
    vi.spyOn(mismatchStore.git, "lineAges").mockReturnValue([new LineAge(999)]);

    await mismatchDream.run();

    const memorySection = mismatchProvider.chatWithRetry.mock.calls[0][0].messages[1].content
      .split("## Current MEMORY.md")[1]
      .split("## Current SOUL.md")[0];
    expect(memorySection).not.toContain("←");
  });

  it("allows Dream write_file to create workspace-relative skills", async () => {
    const store = makeStore();
    const dream = new Dream({ store, provider: provider(), model: "test-model" });
    const writeTool = dream.tools.get("write_file");

    const result = await writeTool?.execute({
      path: "skills/test-skill/SKILL.md",
      content: "---\nname: test-skill\ndescription: Test\n---\n",
    });

    expect(String(result)).toBe(`Successfully wrote ${path.join(store.workspace, "skills", "test-skill", "SKILL.md")}`);
    expect(String(result)).not.toContain("Lint results:");
    expect(fs.existsSync(path.join(store.workspace, "skills", "test-skill", "SKILL.md"))).toBe(true);
  });

  it("points skill creation guidance at the builtin skill-creator template", async () => {
    const store = makeStore();
    store.appendHistory("Repeated workflow one");
    store.appendHistory("Repeated workflow two");
    const p = provider("[SKILL] test-skill: test description");
    const dream = new Dream({ store, provider: p, model: "test-model", maxBatchSize: 5 });
    const runner = { run: vi.fn(async () => runResult("completed")) };
    (dream as any).runner = runner;

    await dream.run();

    expect(runner.run).toHaveBeenCalled();
    const spec = (runner.run.mock.calls[0] as any[])[0];
    expect(spec.initialMessages[0].content).toContain(path.join(process.cwd(), "src", "skills", "skill-creator", "SKILL.md"));
  });

  it("includes MEMORY.md in the phase 1 prompt when git is unavailable", async () => {
    const store = makeStore();
    store.appendHistory("some event");
    const p = provider("[SKIP]");
    const dream = new Dream({ store, provider: p, model: "test-model" });
    (dream as any).runner = { run: vi.fn(async () => runResult("completed")) };

    await dream.run();

    const userMessage = p.chatWithRetry.mock.calls[0][0].messages[1].content;
    expect(userMessage).toContain("## Current MEMORY.md");
    expect(userMessage).toContain("- Project X active");
  });

  it("does not annotate SOUL.md or USER.md with line ages", async () => {
    const store = makeStore();
    store.appendHistory("some event");
    const p = provider("[SKIP]");
    const dream = new Dream({ store, provider: p, model: "test-model" });
    (dream as any).runner = { run: vi.fn(async () => runResult("completed")) };
    vi.spyOn(store.git, "lineAges").mockReturnValue([new LineAge(30), new LineAge(20)]);

    await dream.run();

    const userMessage = p.chatWithRetry.mock.calls[0][0].messages[1].content;
    const soulSection = userMessage.split("## Current SOUL.md")[1].split("## Current USER.md")[0];
    const userSection = userMessage.split("## Current USER.md")[1];
    expect(soulSection).not.toContain("←");
    expect(userSection).not.toContain("←");
  });

  it("adds age suffixes only for MEMORY.md lines older than the stale threshold", async () => {
    const store = makeStore();
    store.writeMemory("# Memory\n- Project X active\n- fresh item\n- edge case line");
    store.appendHistory("some event");
    const p = provider("[SKIP]");
    const dream = new Dream({ store, provider: p, model: "test-model" });
    (dream as any).runner = { run: vi.fn(async () => runResult("completed")) };
    vi.spyOn(store.git, "lineAges").mockReturnValue([
      new LineAge(30),
      new LineAge(20),
      new LineAge(14),
      new LineAge(5),
    ]);

    await dream.run();

    const userMessage = p.chatWithRetry.mock.calls[0][0].messages[1].content;
    const memorySection = userMessage.split("## Current MEMORY.md")[1].split("## Current SOUL.md")[0];
    expect(memorySection).toContain("← 30d");
    expect(memorySection).toContain("← 20d");
    expect(memorySection).not.toContain("← 14d");
    expect(memorySection).not.toContain("← 5d");
  });

  it("skips line-age annotation when disabled", async () => {
    const store = makeStore();
    store.appendHistory("some event");
    const p = provider("[SKIP]");
    const dream = new Dream({ store, provider: p, model: "test-model" });
    dream.annotateLineAges = false;
    (dream as any).runner = { run: vi.fn(async () => runResult("completed")) };
    const ageSpy = vi.spyOn(store.git, "lineAges");

    await dream.run();

    expect(ageSpy).not.toHaveBeenCalled();
    expect(p.chatWithRetry.mock.calls[0][0].messages[1].content).not.toContain("←");
  });

  it("skips line-age annotation when blame line counts mismatch", async () => {
    const store = makeStore();
    store.appendHistory("some event");
    const p = provider("[SKIP]");
    const dream = new Dream({ store, provider: p, model: "test-model" });
    (dream as any).runner = { run: vi.fn(async () => runResult("completed")) };
    vi.spyOn(store.git, "lineAges").mockReturnValue([new LineAge(999)]);

    await dream.run();

    const userMessage = p.chatWithRetry.mock.calls[0][0].messages[1].content;
    const memorySection = userMessage.split("## Current MEMORY.md")[1].split("## Current SOUL.md")[0];
    expect(memorySection).not.toContain("←");
  });

  it("renders the stale-threshold constant in the phase 1 system prompt", async () => {
    const store = makeStore();
    store.appendHistory("some event");
    const p = provider("[SKIP]");
    const dream = new Dream({ store, provider: p, model: "test-model" });
    (dream as any).runner = { run: vi.fn(async () => runResult("completed")) };

    await dream.run();

    expect(p.chatWithRetry.mock.calls[0][0].messages[0].content).toContain("N>14");
  });

  it("caps a huge MEMORY.md preview in the phase 1 prompt", async () => {
    const store = makeStore();
    const p = provider("[SKIP]");
    const dream = new Dream({ store, provider: p, model: "test-model" });
    store.writeMemory("M".repeat(dream.memoryFileMaxChars * 5));
    store.appendHistory("some event");
    (dream as any).runner = { run: vi.fn(async () => runResult("completed")) };

    await dream.run();

    const userMessage = p.chatWithRetry.mock.calls[0][0].messages[1].content;
    const memorySection = userMessage.split("## Current MEMORY.md")[1].split("## Current SOUL.md")[0];
    expect(memorySection.length).toBeLessThan(dream.memoryFileMaxChars + 500);
  });

  it("caps a huge legacy history entry in the phase 1 prompt", async () => {
    const store = makeStore();
    const p = provider("[SKIP]");
    const dream = new Dream({ store, provider: p, model: "test-model" });
    fs.writeFileSync(
      store.historyFile,
      `${JSON.stringify({
        cursor: 1,
        timestamp: "2026-04-01 10:00",
        content: "H".repeat(dream.historyEntryPreviewMaxChars * 8),
      })}\n`,
      "utf8",
    );
    (dream as any).runner = { run: vi.fn(async () => runResult("completed")) };

    await dream.run();

    const userMessage = p.chatWithRetry.mock.calls[0][0].messages[1].content;
    const historySection = userMessage.split("## Conversation History\n")[1].split("\n\n## Current Date")[0];
    expect(historySection.length).toBeLessThan(dream.historyEntryPreviewMaxChars + 500);
  });
});
