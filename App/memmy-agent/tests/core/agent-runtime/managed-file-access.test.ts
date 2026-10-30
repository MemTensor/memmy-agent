import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createManagedExecutionScope, withManagedExecution } from "../../../src/core/agent-runtime/managed-execution.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { ToolCallRequest } from "../../../src/providers/base.js";
import { ListDirTool, ReadFileTool, WriteFileTool } from "../../../src/core/agent-runtime/tools/filesystem.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it.each(["read_file", "write_file", "list_dir"])("%s never accesses native files after a Host grant", async name => {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "managed-files-")));
  roots.push(workspace);
  const target = path.join(workspace, "file.txt");
  await fs.writeFile(target, "unchanged");
  const tool = name === "read_file" ? new ReadFileTool({ workspace })
    : name === "list_dir" ? new ListDirTool({ workspace }) : new WriteFileTool({ workspace });
  const native = vi.spyOn(tool, "execute");
  vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
  let reply!: (value: Response) => void;
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn((_url, init) => {
    requests.push(JSON.parse(init.body)); return new Promise(resolve => { reply = resolve; });
  }));
  const scope = createManagedExecutionScope({ protocol: 2,
    tools: [{ name, description: "Host file operation", inputSchema: { type: "object" } }],
    url: "http://127.0.0.1:12345/authorize", token: "a".repeat(64) }, new AbortController().signal);
  const pending = withManagedExecution(scope, () => new AgentRunner().executeTools(new AgentRunSpec({
    workspace, tools: { get: () => tool, prepareCall: () => { throw new Error("native preparation must not run"); } } as any
  }), [new ToolCallRequest({ id: "file-call", name, arguments: { path: target, content: "changed" } })]));
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(native).not.toHaveBeenCalled();
  expect(await fs.readFile(target, "utf8")).toBe("unchanged");
  reply(Response.json({ decision: "allow", result: "Host performed IO" }));
  const [result] = await pending;
  expect(result.result).toBe("Host performed IO");
  expect(result.event.status).toBe("ok");
  expect(native).not.toHaveBeenCalled();
  expect(await fs.readFile(target, "utf8")).toBe("unchanged");
  expect(requests[0]).toMatchObject({ callId: "file-call", toolName: name, args: { path: target } });
});

it("cannot fall back to native write when the Host approves without an execution result", async () => {
  vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow" })));
  const execute = vi.fn();
  const scope = createManagedExecutionScope({ protocol: 2,
    tools: [{ name: "write_file", description: "write", inputSchema: {} }],
    url: "http://127.0.0.1:12345/authorize", token: "a".repeat(64) }, new AbortController().signal);
  const [result] = await withManagedExecution(scope, () => new AgentRunner().executeTools(new AgentRunSpec({
    tools: { execute, get: () => ({ readOnly: false }) } as any
  }), [new ToolCallRequest({ id: "missing", name: "write_file", arguments: { path: "file", content: "wrong" } })]));
  expect(result.event.status).toBe("error");
  expect(result.result).toContain("execution result is missing");
  expect(execute).not.toHaveBeenCalled();
});
