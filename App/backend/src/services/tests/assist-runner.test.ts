import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpError } from "../assist/acp-client.js";
import { adaptersDirectory } from "../assist/adapters.js";
import { ASSIST_LOGIN_ENV } from "../assist/login.js";
import { createAcpAssistRunner } from "../assist/runner.js";
import type { AssistRunner } from "../collab-assist-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workdir(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-assist-runner-"));
  roots.push(root);
  return root;
}

function lines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 一个「没登录就跑不起来」的 Claude Code 适配器：session/new 先回认证错误，
 * 登录完成（标记文件出现）之后才给会话。同时把收到的请求记进 calls 文件。
 */
const FAKE_ADAPTER = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--cli")) {
  // 适配器把 --cli 之后的参数交给自带的 claude，这里只回答 auth status。
  process.stdout.write(JSON.stringify({ loggedIn: process.env.FAKE_LOGGED_IN === "1" }));
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const record = (name) => { if (process.env.FAKE_CALLS) fs.appendFileSync(process.env.FAKE_CALLS, name + "\n"); };
const signedIn = () => Boolean(process.env.FAKE_STATE) && fs.existsSync(process.env.FAKE_STATE);
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
    if (message.method === "initialize") reply(message.id, { protocolVersion: 1, authMethods: [{ id: "claude-ai-login" }] });
    else if (message.method === "session/new") {
      if (!signedIn()) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } });
      } else {
        reply(message.id, { sessionId: "s-1" });
      }
    } else if (message.method === "authenticate") {
      // 适配器自己的登录方法在没登录时也拿不到身份：仍然失败，让它走到登录页那一步。
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } });
    } else if (message.method === "session/prompt") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
      reply(message.id, { stopReason: "end_turn" });
    }
  }
});
process.stdin.resume();
`;

/** 一次「真的登录成功」的登录命令：写下登录标记，并留一个「跑过」的痕迹。 */
const SUCCESSFUL_LOGIN = 'require("node:fs").writeFileSync("__STATE__", "1");require("node:fs").writeFileSync("__MARKER__", "1");';

interface Harness {
  runner: AssistRunner;
  calls: string;
  state: string;
  loginRan: string;
}

/**
 * 一个装好假适配器的 home。登录命令用环境变量覆盖成一段脚本，脚本的行为由 body 决定：
 * 正常登录会写下 state，让下一次 session/new 成功。
 */
function harness(loginBody: string): Harness {
  const home = workdir();
  const binDir = join(adaptersDirectory(home), "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const adapter = join(binDir, "claude-agent-acp");
  writeFileSync(adapter, `#!${process.execPath}\n${FAKE_ADAPTER}`);
  chmodSync(adapter, 0o755);

  const calls = join(home, "calls.log");
  const state = join(home, "signed-in");
  const loginRan = join(home, "login-ran");
  const login = join(home, "login.js");
  writeFileSync(login, `#!${process.execPath}\n${loginBody.replaceAll("__STATE__", state).replaceAll("__MARKER__", loginRan)}`);
  chmodSync(login, 0o755);

  const env = {
    PATH: "/usr/bin:/bin",
    FAKE_CALLS: calls,
    FAKE_STATE: state,
    [ASSIST_LOGIN_ENV("claude_code")]: login
  } as NodeJS.ProcessEnv;

  const runner = createAcpAssistRunner({ env, home, loginTimeoutMs: 10_000 });
  return { runner, calls, state, loginRan };
}

/** 一次协助请求的最小输入。 */
function input(steps: string[] = []): Parameters<AssistRunner["run"]>[0] {
  return {
    agent: "claude_code",
    cwd: workdir(),
    prompt: "只回复 ok",
    request: { id: "r-1", projectId: "p-1" } as Parameters<AssistRunner["run"]>[0]["request"],
    signal: new AbortController().signal,
    onStep: (step) => steps.push(step.text),
    onSession: () => undefined
  };
}

describe("没登录时代为登录并重跑一次", () => {
  it("opens the login page and retries the same request once", async () => {
    const { runner, calls, loginRan } = harness(SUCCESSFUL_LOGIN);
    const steps: string[] = [];

    const result = await runner.run(input(steps));

    expect(result.reply).toBe("ok");
    // 执行方看得到浏览器已经打开，知道要去完成哪一步。
    expect(steps.join("\n")).toContain("Claude Code 没有登录，已在浏览器打开登录页，请在浏览器中完成登录");
    expect(existsSync(loginRan)).toBe(true);
    // 登录前失败一次、登录后成功一次：只重试一次，不多试。
    expect(lines(calls).filter((call) => call === "session/new")).toHaveLength(2);
    expect(lines(calls).filter((call) => call === "session/prompt")).toHaveLength(1);
  });

  it("gives a readable reason when the login is not finished", async () => {
    const { runner, calls } = harness("process.exit(2);");

    const error = await runner.run(input()).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AcpError);
    expect((error as AcpError).kind).toBe("unauthenticated");
    expect((error as AcpError).message).toBe("Claude Code 的登录没有完成，完成登录后再试");
    // 登录都没成就不该重跑：只留下失败的那一次会话请求。
    expect(lines(calls).filter((call) => call === "session/new")).toHaveLength(1);
  });

  it("does not retry more than once when the retry also needs login", async () => {
    // 登录命令正常退出，但登录其实没生效：重跑照样失败，这里必须收手。
    const { runner, calls } = harness("process.exit(0);");

    const error = await runner.run(input()).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AcpError);
    expect((error as AcpError).kind).toBe("unauthenticated");
    expect(lines(calls).filter((call) => call === "session/new")).toHaveLength(2);
  });

  it("does not open a login page when the agent runs without it", async () => {
    const { runner, calls, loginRan, state } = harness(SUCCESSFUL_LOGIN);
    writeFileSync(state, "1");

    const result = await runner.run(input());

    expect(result.reply).toBe("ok");
    expect(existsSync(loginRan)).toBe(false);
    expect(lines(calls).filter((call) => call === "session/new")).toHaveLength(1);
  });

  it("stops instead of opening a login page when the person stopped the run", async () => {
    const { runner, calls, loginRan } = harness(SUCCESSFUL_LOGIN);
    const controller = new AbortController();
    controller.abort();

    const error = await runner.run({
      ...input(),
      signal: controller.signal
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AcpError);
    expect((error as AcpError).kind).toBe("cancelled");
    expect(existsSync(loginRan)).toBe(false);
    expect(lines(calls).filter((call) => call === "session/new")).toHaveLength(0);
  });
});
