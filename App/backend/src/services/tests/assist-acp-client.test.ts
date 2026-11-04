import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AcpError, runAcpAgent } from "../assist/acp-client.js";

/** 一个说得清话的假 Agent：按 ACP 的顺序回应 initialize、session/new、session/prompt。 */
const FAKE_AGENT = String.raw`
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") reply(message.id, { protocolVersion: 1, agentCapabilities: {} });
    else if (message.method === "session/new") reply(message.id, { sessionId: "s-1" });
    else if (message.method === "session/prompt") {
      // 先说一句话，再做一步工具调用，中途请求一次审批，最后给出结果。
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "先看版本。" } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "tool_call", title: "运行 sw_vers" } } });
      send({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: { sessionId: "s-1", options: [ { optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "never", name: "Reject", kind: "reject_once" } ] } });
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "tool_call_update", title: "运行 sw_vers", status: "completed", content: [ { type: "content", content: { type: "text", text: "macOS 15.6" } } ] } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "版本是 15.6。" } } } });
        reply(message.id, { stopReason: "end_turn" });
      }, 10);
    }
  }
});
process.stdin.resume();
`;

/** 假 Agent 收到审批请求后记下我们回了什么；由 stdout 的最后一行带出来。 */
const RECORDING_AGENT = String.raw`
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s-2" } });
    else if (message.method === "session/prompt") {
      send({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: { options: [ { optionId: "allow", name: "Allow", kind: "allow_once" } ] } });
      setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }), 40);
    } else if (message.id === 77) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-2", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(message.result) } } } });
    }
  }
});
process.stdin.resume();
`;

function scriptPath(source: string): string {
  return fileURLToPath(new URL(`data:text/javascript,${encodeURIComponent(source)}`, "file:"));
}

describe("runAcpAgent", () => {
  it("creates a session, streams messages and tool steps, and ends with the reply", async () => {
    const steps: string[] = [];
    const result = await runAcpAgent({
      command: process.execPath,
      args: ["-e", FAKE_AGENT],
      cwd: process.cwd(),
      prompt: "看一下版本",
      onStep: (step) => steps.push(`${step.text}${step.output ? ` → ${step.output}` : ""}`),
      timeoutMs: 5_000
    });

    expect(result.sessionId).toBe("s-1");
    expect(result.reply).toBe("先看版本。版本是 15.6。");
    // 一步工具调用在开始时记一条、完成时带输出再记一条：界面按顺序显示，最后一条带结果。
    expect(steps[0]).toBe("运行 sw_vers");
    expect(steps.at(-1)).toBe("运行 sw_vers → macOS 15.6");
  });

  it("allows the Agent's permission requests without asking the person again", async () => {
    const result = await runAcpAgent({
      command: process.execPath,
      args: ["-e", RECORDING_AGENT],
      cwd: process.cwd(),
      prompt: "看一下版本",
      timeoutMs: 5_000
    });

    // 执行方授权了这次协助，就代表允许它平时能做的事：这里回的是「允许一次」，不是继续问她。
    expect(result.reply).toContain('"outcome":"selected"');
    expect(result.reply).toContain('"optionId":"allow"');
  });

  it("says the Agent is not installed when the command does not exist", async () => {
    await expect(runAcpAgent({
      command: "/definitely/not/here/memmy-assist-agent",
      args: [],
      cwd: process.cwd(),
      prompt: "在小红书…",
      timeoutMs: 5_000
    })).rejects.toBeInstanceOf(AcpError);
  });

  it("stops when the person stops it, without waiting for the Agent", async () => {
    const controller = new AbortController();
    const run = runAcpAgent({
      command: process.execPath,
      args: ["-e", "process.stdin.resume();"],
      cwd: process.cwd(),
      prompt: "慢慢来",
      signal: controller.signal,
      timeoutMs: 5_000
    });
    controller.abort();
    const error = await run.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AcpError);
    expect((error as AcpError).kind).toBe("cancelled");
  });
});