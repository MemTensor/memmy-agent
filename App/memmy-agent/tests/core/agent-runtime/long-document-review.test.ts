import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { ReadFileTool } from "../../../src/core/agent-runtime/tools/filesystem.js";
import { ExecTool } from "../../../src/core/agent-runtime/tools/shell.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { ExecSessionManager, WriteStdinTool } from "../../../src/core/agent-runtime/tools/exec-session.js";
import { SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME } from "../../../src/core/agent-runtime/tool-result-budget.js";
import { LLMProvider, LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { renderTemplate } from "../../../src/utils/prompt-templates.js";
import { REPORT_FACTS, reportText, writeDocx } from "../../helpers/long-document-fixtures.js";

const roots: string[] = [];
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-document-review-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

// Scripted decisions validate runtime/tool plumbing, NOT real-model compliance.
class ScriptedReader extends LLMProvider {
  calls = 0;
  constructor(private readonly decide: (messages: any[], turn: number) => LLMResponse) { super(); }
  getDefaultModel() { return "scripted-review-not-a-real-model"; }
  async chat(args: any) { return this.decide(args.messages, this.calls++); }
  async chatWithRetry(args: any) { return this.chat(args); }
}
function call(name: string, args: any, turn: number) {
  return new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: `review-${turn}`, name, arguments: args })] });
}
function spec(root: string, tools: ToolRegistry) {
  return new AgentRunSpec({
    workspace: root, tools, maxIterations: 40,
    toolResultMaxCharsByName: SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME,
    initialMessages: [
      { role: "system", content: renderTemplate("agent/tool-contract.md") },
      { role: "user", content: "Read the entire synthetic report and return every VERIFIED figure." },
    ],
  });
}
const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

describe("long-document review through the real AgentRunner", () => {
  it("delivers continuation cursors and all late facts across multiple tool turns", async () => {
    const root = await workspace();
    const file = await writeDocx(root, reportText());
    const tools = new ToolRegistry();
    tools.register(new ReadFileTool({ workspace: root }));
    const provider = new ScriptedReader((messages, turn) => {
      const outputs = messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      if (!outputs.length) return call("read_file", { path: file }, turn);
      const last = outputs.at(-1)!;
      const next = /Continue with char_offset=(\d+)/.exec(last);
      if (next) return call("read_file", { path: file, char_offset: Number(next[1]) }, turn);
      expect(last).toContain("End of document");
      const figures = outputs.join("\n").match(/(?:PE|HOLDING|ISSUED|RAISED)=[0-9.%]+/g);
      return new LLMResponse({ content: JSON.stringify(figures) });
    });
    const result = await new AgentRunner(provider).run(spec(root, tools));
    expect(JSON.parse(result.finalContent!)).toEqual(REPORT_FACTS);
    expect(result.messages.filter((m) => m.role === "tool").length).toBeGreaterThan(8);
    expect(result.toolEvents.every((e) => e.status === "ok")).toBe(true);
  });

  it("documents that a model can still stop early despite a continuation marker", async () => {
    const root = await workspace();
    const file = await writeDocx(root, reportText());
    const tools = new ToolRegistry();
    tools.register(new ReadFileTool({ workspace: root }));
    const provider = new ScriptedReader((_, turn) => turn === 0
      ? call("read_file", { path: file }, turn)
      : new LLMResponse({ content: "Stopped without reading the remainder." }));
    const result = await new AgentRunner(provider).run(spec(root, tools));
    const outputs = result.messages.filter((m) => m.role === "tool");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].content).toContain("Continue with char_offset=");
    expect(result.finalContent).toBe("Stopped without reading the remainder.");
  });

  it("recovers exec's omitted middle by saving output and reading the file in ranges", async () => {
    const root = await workspace();
    const input = reportText(60_000);
    await fs.writeFile(path.join(root, "source.txt"), input);
    await fs.writeFile(path.join(root, "emit.cjs"), 'process.stdout.write(require("node:fs").readFileSync("source.txt", "utf8"));');
    const command = `${quote(process.execPath)} emit.cjs`;
    const tools = new ToolRegistry();
    tools.register(new ExecTool({ workspace: root }));
    tools.register(new ReadFileTool({ workspace: root }));
    const provider = new ScriptedReader((messages, turn) => {
      const outputs = messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      if (turn === 0) return call("exec", { command }, turn);
      if (turn === 1) {
        expect(outputs[0]).toContain("truncated");
        expect(outputs[0]).not.toContain(REPORT_FACTS[1]);
        return call("exec", { command: `${command} > extracted.txt` }, turn);
      }
      if (turn === 2) return call("read_file", { path: "extracted.txt", limit: 150 }, turn);
      const next = /Use offset=(\d+) to continue/.exec(outputs.at(-1)!);
      if (next) return call("read_file", { path: "extracted.txt", offset: Number(next[1]), limit: 150 }, turn);
      expect(outputs.at(-1)).toContain("End of file");
      const figures = outputs.slice(2).join("\n").match(/(?:PE|HOLDING|ISSUED|RAISED)=[0-9.%]+/g);
      return new LLMResponse({ content: JSON.stringify(figures) });
    });
    const result = await new AgentRunner(provider).run(spec(root, tools));
    expect(JSON.parse(result.finalContent!)).toEqual(REPORT_FACTS);
    expect(await fs.readFile(path.join(root, "extracted.txt"), "utf8")).toBe(input);
  });

  it("confirms completed exec sessions cannot replay omitted output", async () => {
    const root = await workspace();
    const source = "a".repeat(30_000) + "MISSING_MIDDLE_FACT" + "z".repeat(30_000);
    await fs.writeFile(path.join(root, "source.txt"), source);
    await fs.writeFile(path.join(root, "emit.cjs"), 'process.stdout.write(require("node:fs").readFileSync("source.txt", "utf8"));');
    const manager = new ExecSessionManager();
    try {
      // The manager returns the id even when the completed tool response omits it.
      const [id, first] = await manager.start({ command: `${quote(process.execPath)} emit.cjs`, cwd: root, yieldTimeMs: 1000, maxOutputChars: 1000 });
      expect(first.done).toBe(true);
      expect(first.truncatedChars).toBeGreaterThan(0);
      expect(first.output).not.toContain("MISSING_MIDDLE_FACT");
      const next = await new WriteStdinTool({ manager }).execute({ session_id: id, yield_time_ms: 0 });
      expect(next).not.toContain("MISSING_MIDDLE_FACT");
      expect(next).not.toContain("a".repeat(20));
      expect(next).toContain("exec session not found");
    } finally {
      for (const session of manager.sessions.values()) await session.kill();
    }
  });

  it("exposes the remaining oversized single-line text recovery limitation", async () => {
    const root = await workspace();
    const file = path.join(root, "single-line-extraction.txt");
    await fs.writeFile(file, "x".repeat(200_000) + "TAIL");
    const result = await new ReadFileTool({ workspace: root }).execute({ path: file });
    // Characterization of a known gap, not evidence that this recovery route is safe.
    expect(result.length).toBeGreaterThan(ReadFileTool.MAX_CHARS);
    expect(result).not.toContain("Use offset=");
    expect(result).toContain("End of file");
  });
});
