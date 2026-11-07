import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcpError,
  assistReplyError,
  isAuthenticationError,
  resolveConfigValue,
  runAcpAgent,
  stripTrailingStreamNoise
} from "../assist/acp-client.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 一个临时目录，用来放「收到过哪些请求」与「认证过没有」两个标记。 */
function workdir(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-assist-auth-"));
  roots.push(root);
  return root;
}

function calls(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 一个按模式行事的假 Agent。模式决定 session/new 与 session/prompt 怎么回应；
 * 每收到一个请求都把方法名记进 FAKE_RECORD，用来断言「有没有调 authenticate」。
 */
const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const mode = process.argv[1];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const record = (name) => { if (process.env.FAKE_RECORD) fs.appendFileSync(process.env.FAKE_RECORD, name + "\n"); };
const authed = () => Boolean(process.env.FAKE_AUTHED) && fs.existsSync(process.env.FAKE_AUTHED);
const chunk = (text) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
let buffer = "";
process.stdin.on("data", (data) => {
  buffer += data.toString("utf8");
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    record(message.method);
    if (message.method === "initialize") {
      const authMethods = mode === "no-auth-methods" ? [] : [{ id: "faux-login", name: "Faux" }];
      reply(message.id, { protocolVersion: 1, authMethods });
    } else if (message.method === "session/new") {
      // 需要登录的三种模式在登录之前都回同一个认证错误。
      if (mode !== "never-needs-auth" && mode !== "prompt-auth" && !authed()) {
        return fail(message.id, -32000, "Authentication required: Authentication is required.");
      }
      if (mode === "config") {
        return reply(message.id, { sessionId: "s-1", configOptions: [{ id: "model", currentValue: "kimi-k3[reasoning=max]", options: [{ value: "default[]", name: "Auto" }, { value: "kimi-k3[reasoning=max]", name: "kimi-k3" }] }] });
      }
      reply(message.id, { sessionId: "s-1" });
    } else if (message.method === "session/set_config_option") {
      record("set:" + message.params.configId + "=" + message.params.value);
      reply(message.id, { configOptions: [] });
    } else if (message.method === "authenticate") {
      if (mode === "auth-hangs") return; // 一直不回应：实测 QwenWork 就是这样
      if (process.env.FAKE_AUTHED) fs.writeFileSync(process.env.FAKE_AUTHED, "1");
      reply(message.id, {});
    } else if (message.method === "session/prompt") {
      if (mode === "prompt-auth") return fail(message.id, -32000, "Authentication required");
      if (mode === "reply-error") {
        chunk("Error: I: WritableIterable is closed");
        return reply(message.id, { stopReason: "end_turn" });
      }
      if (mode === "quota") {
        chunk("\n\nUpgrade your plan to continue");
        return reply(message.id, { stopReason: "end_turn" });
      }
      if (mode === "ok-with-noise") {
        chunk("ok");
        chunk("\n\nError: RetriableError: WritableIterable is closed");
        return reply(message.id, { stopReason: "end_turn" });
      }
      if (mode === "reply-with-error-text") {
        chunk("运行日志里有 Error: timeout 这一行，但它只是日志。");
        return reply(message.id, { stopReason: "end_turn" });
      }
      chunk("ok");
      reply(message.id, { stopReason: "end_turn" });
    }
  }
});
process.stdin.resume();
`;

interface FakeRun {
  result?: { reply: string; transcript: Array<{ kind: string; text?: string }> };
  error?: unknown;
  calls: string[];
}

/** 跑一次假 Agent；登录标记放在临时目录里，认证成功由 Agent 自己写下。 */
async function run(
  mode: string,
  extra: { authTimeoutMs?: number; agentName?: string; sessionConfig?: Record<string, string> } = {}
): Promise<FakeRun> {
  const root = workdir();
  const file = join(root, "calls.log");
  const result = await runAcpAgent({
    command: process.execPath,
    args: ["-e", FAKE_AGENT, mode],
    cwd: process.cwd(),
    prompt: "只回复 ok",
    env: { ...process.env, FAKE_RECORD: file, FAKE_AUTHED: join(root, "authed") },
    timeoutMs: 10_000,
    ...extra
  }).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  );
  return { ...(result.value ? { result: result.value } : {}), ...(result.error ? { error: result.error } : {}), calls: calls(file) };
}

describe("authenticate 按需调用", () => {
  it("does not authenticate when the session opens without it", async () => {
    const { result, calls: seen } = await run("never-needs-auth");
    expect(result?.reply).toBe("ok");
    // QwenWork 的登录方法会一直不回应：不能因为 initialize 给了 authMethods 就先无条件调一遍。
    expect(seen).not.toContain("authenticate");
  });

  it("authenticates once and retries the session when the agent asks for it", async () => {
    const { result, calls: seen } = await run("needs-auth");
    expect(result?.reply).toBe("ok");
    expect(seen.filter((call) => call === "authenticate")).toHaveLength(1);
    expect(seen.filter((call) => call === "session/new")).toHaveLength(2);
  });

  it("stops waiting for authenticate after the short timeout and reports needing login", async () => {
    const started = Date.now();
    const { error } = await run("auth-hangs", { authTimeoutMs: 300 });
    expect((error as AcpError).kind).toBe("unauthenticated");
    // 15 分钟的总超时不能先到：登录方法不回应时这里必须自己收尾。
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("reports an authentication failure from session/prompt as needing login", async () => {
    const { error } = await run("prompt-auth");
    expect((error as AcpError).kind).toBe("unauthenticated");
  });

  it("reports needing login even when the agent offers no login method", async () => {
    // 没有登录方法就不能替它认证，但这个错误仍然是「登录一下就能跑」，上层据此提示去登录。
    const { error, calls: seen } = await run("no-auth-methods");
    expect((error as AcpError).kind).toBe("unauthenticated");
    expect(seen).not.toContain("authenticate");
  });
});

describe("isAuthenticationError", () => {
  it("recognises authentication wording and the -32000 code", () => {
    expect(isAuthenticationError(new AcpError("Authentication required", "failed"))).toBe(true);
    expect(isAuthenticationError(new AcpError("Please log in first", "failed"))).toBe(true);
    const coded = Object.assign(new AcpError("会话被拒绝", "failed"), { code: -32000 });
    expect(isAuthenticationError(coded)).toBe(true);
  });

  it("does not treat an unrelated failure as a login problem", () => {
    // 模型没配好是 -32603：把它当认证问题会把人带到登录页，而问题在别处。
    const failure = Object.assign(new AcpError('no credential for provider route "deepseek-official"', "failed"), {
      code: -32603
    });
    expect(isAuthenticationError(failure)).toBe(false);
    expect(isAuthenticationError(new Error("boom"))).toBe(false);
  });
});

describe("把 Error: 回复当失败", () => {
  it("reports a short Error: reply with no tool calls as a failure", async () => {
    const { error } = await run("reply-error", { agentName: "Cursor" });
    expect(error).toBeInstanceOf(AcpError);
    expect((error as AcpError).kind).toBe("failed");
    expect((error as AcpError).message).toBe("Cursor 返回错误：Error: I: WritableIterable is closed");
    // 失败轮次也要留下执行过程：双方能看到它走到哪一步。
    expect(Array.isArray((error as AcpError).transcript)).toBe(true);
  });

  it("keeps a normal reply that happens to mention Error:", async () => {
    const { result } = await run("reply-with-error-text");
    expect(result?.reply).toContain("只是日志");
  });

  it("only matches the whole reply, not a long or multi-line one", () => {
    expect(assistReplyError("Error: boom", 0, "Cursor")).toBe("Cursor 返回错误：Error: boom");
    // 做过工具调用的一轮不算：过程本身有意义。
    expect(assistReplyError("Error: boom", 2, "Cursor")).toBeNull();
    expect(assistReplyError("Error: 第一行\n第二行的说明", 0, "Cursor")).toBeNull();
    expect(assistReplyError(`Error: ${"x".repeat(401)}`, 0, "Cursor")).toBeNull();
    expect(assistReplyError("正常的回答", 0, "Cursor")).toBeNull();
  });
});

describe("Cursor 的额度错误与回复末尾的流关闭报错", () => {
  it("reports an out-of-quota reply as a failure", async () => {
    const { error } = await run("quota", { agentName: "Cursor" });
    expect(error).toBeInstanceOf(AcpError);
    expect((error as AcpError).kind).toBe("failed");
    expect((error as AcpError).message).toBe("Cursor 返回错误：Upgrade your plan to continue");
  });

  it("drops the trailing stream-closed line from a normal reply and its transcript", async () => {
    const { result, error } = await run("ok-with-noise", { agentName: "Cursor" });
    expect(error).toBeUndefined();
    expect(result?.reply).toBe("ok");
    const texts = (result?.transcript ?? []).filter((item) => item.kind === "text").map((item) => item.text);
    expect(texts.join("")).not.toContain("WritableIterable");
  });

  it("still fails when the stream-closed line is the whole reply", async () => {
    const { error } = await run("reply-error", { agentName: "Cursor" });
    expect((error as AcpError).message).toBe("Cursor 返回错误：Error: I: WritableIterable is closed");
  });

  it("strips only that trailing line", () => {
    expect(stripTrailingStreamNoise("ok\n\nError: RetriableError: WritableIterable is closed")).toBe("ok");
    expect(stripTrailingStreamNoise("Error: I: WritableIterable is closed")).toBe("");
    expect(stripTrailingStreamNoise("日志里有 Error: boom\n结论在这")).toBe("日志里有 Error: boom\n结论在这");
  });
});

describe("会话选项（Cursor 统一用 Auto）", () => {
  it("sets the requested option after the session opens, matching by value", async () => {
    const { calls: seen, result } = await run("config", { sessionConfig: { model: "default[]" } });
    expect(result?.reply).toBe("ok");
    expect(seen).toContain("set:model=default[]");
    expect(seen.indexOf("set:model=default[]")).toBeLessThan(seen.indexOf("session/prompt"));
  });

  it("does not send anything without a session config", async () => {
    const { calls: seen } = await run("config");
    expect(seen.some((call) => call.startsWith("set:"))).toBe(false);
  });

  it("resolves the value by display name, sets it even when reported as current, and skips unknown values", () => {
    const options = [{ id: "model", currentValue: "kimi-k3", options: [{ value: "default[]", name: "Auto" }, { value: "kimi-k3", name: "kimi-k3" }] }];
    expect(resolveConfigValue(options, "model", "auto")).toBe("default[]");
    // 报告的当前值不可信（Cursor 报告与实际不一致），照样设。
    expect(resolveConfigValue(options, "model", "kimi-k3")).toBe("kimi-k3");
    expect(resolveConfigValue(options, "model", "nope")).toBeNull();
    // 没给出这个选项（接回旧会话时）就按原值试一次。
    expect(resolveConfigValue([], "model", "default[]")).toBe("default[]");
  });
});
