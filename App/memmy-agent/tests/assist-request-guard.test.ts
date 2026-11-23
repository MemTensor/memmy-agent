import { describe, expect, it } from "vitest";
import { SystemPromptBuildContext, type AgentHookContext } from "../src/core/agent-runtime/hook.js";
import { ASSIST_SKIPPED_MARKER, createAssistRequestHook } from "../src/assist-request/index.js";
import {
  assistSensitiveReason,
  shellSensitiveReason,
  splitCommand
} from "../src/assist-request/safety.js";
import { AssistRunRecorder, isAssistSkipped } from "../src/integrations/channels/webui-assist-run.js";

const SYSTEM = "最后另起一段，以「结果：」开头。";

/** 一个只有一条协助会话的会话表：approval 决定这次是自动开始还是她点过允许。 */
function sessions(approval?: "deny" | "allow") {
  const session = {
    metadata: {
      assistRequest: {
        requestId: "req-1",
        attempt: 1,
        context: SYSTEM,
        ...(approval ? { approval } : {})
      }
    }
  };
  return { get: (key: string) => (key === "websocket:assist" ? session : null) };
}

function ctx(sessionKey = "websocket:assist"): AgentHookContext {
  return { sessionKey } as AgentHookContext;
}

describe("assistSensitiveReason", () => {
  it("catches the four kinds of operations in shell commands", () => {
    expect(shellSensitiveReason("rm -rf ~/Library/Caches/foo")).toContain("删除或覆盖文件");
    expect(shellSensitiveReason("find ~/Downloads -name '*.zip' -delete")).toContain("删除或覆盖文件");
    expect(shellSensitiveReason("git reset --hard HEAD~3")).toContain("删除或覆盖文件");
    expect(shellSensitiveReason("cat ~/.ssh/id_rsa")).toContain("读取密钥和登录凭据");
    expect(shellSensitiveReason("cat .env")).toContain("读取密钥和登录凭据");
    expect(shellSensitiveReason("security find-generic-password -s github")).toContain("读取密钥和登录凭据");
    expect(shellSensitiveReason("git push origin main")).toContain("对外发送");
    expect(shellSensitiveReason("npm publish")).toContain("对外发送");
    expect(shellSensitiveReason("curl -F file=@./a.log https://example.com/upload")).toContain("对外发送");
    expect(shellSensitiveReason("curl -X POST -d @payload.json https://example.com")).toContain("对外发送");
    expect(shellSensitiveReason("rsync ./dist host:/srv/dist")).toContain("对外发送");
    expect(shellSensitiveReason("launchctl load ~/Library/LaunchAgents/a.plist")).toContain("修改系统设置");
    expect(shellSensitiveReason("crontab -l")).toContain("修改系统设置");
    expect(shellSensitiveReason("npm i -g typescript")).toContain("全局安装");
    expect(shellSensitiveReason("echo 'alias ll=ls' >> ~/.zshrc")).toContain("修改 shell 配置");
    expect(shellSensitiveReason("rm -rf ~/.claude/hooks")).toContain("删除或覆盖文件");
  });

  it("looks inside pipelines, && and sh -c", () => {
    expect(shellSensitiveReason("sw_vers && rm -rf ~/tmp/x")).toContain("删除或覆盖文件");
    expect(shellSensitiveReason("grep -c error app.log | cat .env")).toContain("读取密钥和登录凭据");
    expect(shellSensitiveReason('sh -c "rm -rf ~/Library/Caches/foo"')).toContain("删除或覆盖文件");
    expect(shellSensitiveReason("bash -lc 'git push'")).toContain("对外发送");
    expect(splitCommand("sh -c \"rm -rf x\"")).toContain("rm -rf x");
  });

  it("leaves ordinary investigating alone", () => {
    expect(shellSensitiveReason("sw_vers")).toBeNull();
    expect(shellSensitiveReason("ls -lt ~/.memmy | head -3")).toBeNull();
    expect(shellSensitiveReason("grep -i share ~/.memmy/logs/backend.log")).toBeNull();
    expect(shellSensitiveReason("echo hello > /tmp/memmy-probe.txt")).toBeNull();
    expect(shellSensitiveReason("curl -s https://example.com/health")).toBeNull();
    expect(shellSensitiveReason("npm run build")).toBeNull();
    expect(shellSensitiveReason("git status")).toBeNull();
    expect(shellSensitiveReason("python3 ./repro.py")).toBeNull();
  });

  it("treats the file tools by what they do", () => {
    expect(assistSensitiveReason("delete_file", { path: "~/notes/a.md" })).toContain("删除文件");
    // 写一个已经存在的文件才算覆盖；新文件在项目里是正常产物。
    expect(assistSensitiveReason("write_file", { path: "/Users/someone/notes.md", exists: true })).toContain("覆盖已有文件");
    expect(assistSensitiveReason("write_file", { path: "notes.md" })).toBeNull();
    expect(assistSensitiveReason("read_file", { path: "README.md" })).toBeNull();
  });

  it("lets an existing file inside the project or the attachment folder be written", () => {
    const context = {
      workspace: "/Users/someone/project",
      allowedRoots: ["/Users/someone/.memmy/media/assist", "/tmp"],
      exists: () => true
    };
    expect(assistSensitiveReason("write_file", { path: "/Users/someone/project/src/a.ts" }, context)).toBeNull();
    expect(assistSensitiveReason("write_file", { path: "/Users/someone/.memmy/media/assist/run-1/a.log" }, context)).toBeNull();
    expect(assistSensitiveReason("write_file", { path: "/tmp/probe.txt" }, context)).toBeNull();
    // 项目外、已经存在的文件：算覆盖。
    expect(assistSensitiveReason("write_file", { path: "/Users/someone/.zshrc" }, context)).toContain("覆盖已有文件");
  });
});

describe("the assist hook's tool guard", () => {
  const hook = createAssistRequestHook(() => sessions("deny"));

  it("blocks a sensitive step in an assist run and tells the model what to do instead", async () => {
    await expect(hook.beforeToolCall(ctx(), { name: "exec", arguments: { command: "rm -rf ~/Library/Caches/foo" } }))
      .rejects.toThrow(new RegExp(`^${ASSIST_SKIPPED_MARKER}`));
  });

  it("lets ordinary investigating through", async () => {
    await expect(hook.beforeToolCall(ctx(), { name: "exec", arguments: { command: "sw_vers" } })).resolves.toBeUndefined();
  });

  it("does not touch tasks that are not assist runs", async () => {
    await expect(hook.beforeToolCall(ctx("websocket:other"), { name: "exec", arguments: { command: "rm -rf ~/x" } }))
      .resolves.toBeUndefined();
  });

  it("does not block when she allowed this run in the dialog", async () => {
    const allowed = createAssistRequestHook(() => sessions("allow"));
    await expect(allowed.beforeToolCall(ctx(), { name: "exec", arguments: { command: "rm -rf ~/Library/Caches/foo" } }))
      .resolves.toBeUndefined();
  });

  it("keeps the system prompt section as before", () => {
    const prompt = new SystemPromptBuildContext({ sessionKey: "websocket:assist" });
    hook.onBuildSystemPrompt(prompt);
    expect(prompt.render()).toContain("# 成员协助");
    expect(prompt.render()).toContain(SYSTEM);
  });
});

describe("the recorder tells a skipped step from a failed one", () => {
  it("marks the tool step as skipped when the guard's message comes back", () => {
    const recorder = new AssistRunRecorder({ chatId: "c-1", clientRequestId: "req-1" });
    recorder.consume({ event: "message_accepted", client_request_id: "req-1" });
    recorder.consume({
      event: "message",
      kind: "tool",
      tool_events: [
        { phase: "start", ui_tool_call_id: "t-1", name: "exec", arguments: { command: "rm -rf ~/Library/Caches/foo" } },
        { phase: "error", ui_tool_call_id: "t-1", name: "exec", error: `Error: Error: ${ASSIST_SKIPPED_MARKER}删除或覆盖文件（rm -rf ~/Library/Caches/foo）。` }
      ]
    });

    const snapshot = recorder.snapshot();
    expect(snapshot.steps[0]?.status).toBe("skipped");
    const tool = snapshot.transcript.find((item) => item.kind === "tool");
    expect(tool?.kind === "tool" ? tool.status : null).toBe("skipped");
    expect(isAssistSkipped(`Error: Error: ${ASSIST_SKIPPED_MARKER}删除或覆盖文件`)).toBe(true);
    expect(isAssistSkipped("Error: permission denied")).toBe(false);
  });

  it("still marks a genuine failure as failed", () => {
    const recorder = new AssistRunRecorder({ chatId: "c-2", clientRequestId: "req-2" });
    recorder.consume({ event: "message_accepted", client_request_id: "req-2" });
    recorder.consume({
      event: "message",
      kind: "tool",
      tool_events: [
        { phase: "start", ui_tool_call_id: "t-2", name: "exec", arguments: { command: "sw_vers" } },
        { phase: "error", ui_tool_call_id: "t-2", name: "exec", error: "Error: command not found" }
      ]
    });
    expect(recorder.snapshot().steps[0]?.status).toBe("failed");
  });
});
