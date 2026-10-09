/** Sources sub page tests. */
import { renderToString } from "react-dom/server";
import { MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH } from "@memmy/local-api-contracts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../../api/http.js";
import { AppProviders } from "../../../app/providers.js";
import { enUSMessages, zhCNMessages } from "../../../i18n/messages.js";
import { AGENT_SOURCE_SCAN_COMPLETION_FEEDBACK_MS } from "../../../state/app-actions.js";
import { agentSourceLogoUrl } from "../../agent-source-logos.js";
import {
  buildManagedAgentTaskPrompt,
  formatAgentSourceActionError,
  formatMemoryServiceAddress,
  formatScanProgressTail,
  formatSourceDataPath,
  formatSourceMemoryCount,
  isAgentSourceConnectionActionDisabled,
  resolveAgentSourceScanButtonState,
  resolveAgentSourceConnectionAction,
  resolveManagedAgentSourceSyncButtonState,
  resolveMemoryCliPathMessageKey,
  resolveMemoryDocsUrl,
  resolveAgentSourceStatusLabelKey,
  resolveScanContinueSourceId,
  MANUAL_AGENT_NAME_PRESETS,
  visibleAgentSources
} from "../../memory-sources-page.js";
import { SourcesSubPage } from "../sources-sub-page.js";

describe("SourcesSubPage", () => {
  it("为 Windows CLI 卡片提供 .cmd 命令入口而不是 macOS 安装路径", () => {
    expect((zhCNMessages as Record<string, string>)["memory.cliPathWindows"]).toBe("memmy-memory.cmd");
    expect((enUSMessages as Record<string, string>)["memory.cliPathWindows"]).toBe("memmy-memory.cmd");
    expect(resolveMemoryCliPathMessageKey("win32", true, false)).toBe("memory.cliPathWindows");
    expect(resolveMemoryCliPathMessageKey("win32", false, false)).toBe("memory.cliPath");
    expect(resolveMemoryCliPathMessageKey("win32", true, true)).toBe("memory.cliPath");
    expect(resolveMemoryCliPathMessageKey("darwin", true, false)).toBe("memory.cliPath");
    expect(resolveMemoryCliPathMessageKey(undefined, undefined, undefined)).toBe("memory.cliPath");
  });

  it("只用 Hook 描述 Cursor、Claude Code 和 Codex 的接入操作", () => {
    expect(zhCNMessages["memory.hookInstalled"]).toBe("已安装 Hook");
    expect(zhCNMessages["memory.hookNotInstalled"]).toBe("未安装 Hook");
    expect(zhCNMessages["memory.installHook"]).toBe("安装 Hook");
    expect(zhCNMessages["memory.removeHook"]).toBe("移除 Hook");
    expect(enUSMessages["memory.hookInstalled"]).toBe("Hook installed");
    expect(enUSMessages["memory.hookNotInstalled"]).toBe("Hook not installed");
    expect(enUSMessages["memory.installHook"]).toBe("Install Hook");
    expect(enUSMessages["memory.removeHook"]).toBe("Remove Hook");
  });

  it("同步按钮在扫描中旋转，完成后进入不可重复点击的勾选状态", () => {
    const sourceIds = ["cursor", "claude_code", "codex", "opencode", "openclaw", "hermes", "deepseek_harness", "workbuddy", "pi", "qwenwork"];
    for (const sourceId of sourceIds) {
      const otherSourceId = sourceIds.find((candidate) => candidate !== sourceId)!;
      expect(resolveAgentSourceScanButtonState(sourceId, true, sourceId, new Set())).toBe("running");
      expect(resolveAgentSourceScanButtonState(sourceId, true, otherSourceId, new Set())).toBe("idle");
      expect(resolveAgentSourceScanButtonState(sourceId, false, null, new Set([sourceId]))).toBe("completed");
      expect(resolveAgentSourceScanButtonState(sourceId, false, null, new Set())).toBe("idle");
    }
    expect(zhCNMessages["memory.syncCompleted"]).toBe("同步完成");
    expect(enUSMessages["memory.syncCompleted"]).toBe("Synced");
    expect(AGENT_SOURCE_SCAN_COMPLETION_FEEDBACK_MS).toBe(5000);
  });

  it("手动添加的 Agent 同步完成后显示与内置 Agent 一致的勾选反馈", () => {
    expect(resolveManagedAgentSourceSyncButtonState("manual-qoder", "manual-qoder", null)).toBe("running");
    expect(resolveManagedAgentSourceSyncButtonState("manual-qoder", null, "manual-qoder")).toBe("completed");
    expect(resolveManagedAgentSourceSyncButtonState("manual-qoder", null, null)).toBe("idle");
    expect(resolveManagedAgentSourceSyncButtonState("manual-qoder", "manual-other", "manual-other")).toBe("idle");
  });

  it("使用 WorkBuddy 官方图标而不是文字缩写", () => {
    expect(agentSourceLogoUrl("workbuddy")).toContain("workbuddy.png");
  });

  it("使用用户提供的 Pi、QwenWork 与黑色 DeepSeek Harness 图标", () => {
    expect(agentSourceLogoUrl("pi")).toContain("%3ctitle%3ePi%3c/title%3e");
    expect(agentSourceLogoUrl("qwenwork")).toContain("%3ctitle%3eQwen%3c/title%3e");
    expect(agentSourceLogoUrl("deepseek_harness")).toContain("%23000000");
  });

  it("隐藏未安装的内置 Agent 和尚未验证的自定义 Agent 草稿", () => {
    expect(visibleAgentSources([
      createSource("codex", "not_connected"),
      { ...createSource("workbuddy", "not_connected"), available: false },
      { ...createSource("manual-1", "not_connected"), builtin: false, available: false },
      {
        ...createSource("manual-pending", "not_connected"),
        builtin: false,
        dataPath: MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH
      }
    ]).map((source) => source.sourceId)).toEqual(["codex", "manual-1"]);
  });

  it("复用跨 Agent 接入源主体内容", () => {
    const html = renderToString(
      <AppProviders>
        <SourcesSubPage />
      </AppProviders>
    );

    expect(html).toContain("跨Agent接入");
    expect(html).toContain("memory-sources-page");
    expect(html).toContain("各 Agent 通过 Hook、插件或 Skill 接入 memmy-memory");
    expect(html).toContain("发现新 Agent 时自动接入");
    expect(html).toContain("自动安装接入组件；关闭后只出现在下方列表，由你手动接入");
    expect(html).toContain("~/.local/bin/memmy-memory");
    expect(html).toContain('aria-label="查看记忆服务文档"');
    expect(html).toContain(">了解更多</span>");
    expect(html).toContain("lucide-external-link");
    expect(html).not.toContain('data-icon="codex-help-circle"');
    expect(html).not.toContain("或安装原生插件接入记忆");
    expect(html).toContain("memory-panel__header memory-panel__header--single-line");
    expect(html).toContain("memory-panel__title");
    expect(html).not.toContain("memory-panel__header-actions");
    expect(html).toContain("自动同步");
    expect(html).toContain("同步新增");
    expect(html).toContain("点击“同步新增”按钮后，只会读取上次同步后产生的新对话");
    expect(html).not.toContain("上次扫描水位");
    expect(html).toContain("高级");
    expect(html).not.toContain("高级操作");
    expect(html).not.toContain("添加其他 Agent");
    expect(html).toContain("本地数据存储位置");
    expect(html).toContain("清除所有本地数据");
    expect(html).toContain("打开文件目录");
    expect(html).not.toContain("在访达中显示");
    expect(html).toContain('data-icon="folder-open"');
    expect(html).toContain('data-icon="download"');
    expect(html).toContain('data-icon="trash-2"');
    expect(html).toContain('data-icon="terminal"');
    expect(html).toContain('data-icon="server"');
    expect(html).toContain('data-icon="more-horizontal"');
    expect(html).not.toContain("w-52 border-r border-border-stone/30");
  });

  it("手动添加弹窗复用通用 Modal 和主题按钮", () => {
    const source = readFileSync(resolve(__dirname, "..", "..", "memory-sources-page.tsx"), "utf8");

    expect(source).toContain('import { Modal } from "../components/modal.js";');
    expect(source).toContain("<Modal");
    expect(source).toContain("open={state.modals.manualSource}");
    expect(source).toContain('variant="soft"');
    expect(source).toContain("manual-source-modal__footer");
    expect(source).toContain("options={MANUAL_AGENT_NAME_PRESETS}");
    expect(source).toContain('role="combobox"');
    expect(source).toContain('aria-autocomplete="list"');
    expect(source).toContain("manual-agent-combobox__menu");
    expect(source).not.toContain('import { Select } from "../components/Select.js";');
    expect(source).not.toContain("<datalist");
    expect(source).not.toContain("fixed inset-0 z-50 flex items-center justify-center bg-text-ink/25 backdrop-blur-sm");
  });

  it("手动添加 Agent 可以从预设列表选择或继续自由输入", () => {
    expect(MANUAL_AGENT_NAME_PRESETS).toEqual(["kimi code", "zcode", "minimax code", "coder"]);
    expect(zhCNMessages["memory.addOtherAgentDescription"]).toContain("选择或输入");
    expect(enUSMessages["memory.addOtherAgentDescription"]).toContain("Choose or enter");
  });

  it("手动添加 Agent 可以提供可选的历史会话路径", () => {
    const source = readFileSync(resolve(__dirname, "..", "..", "memory-sources-page.tsx"), "utf8");

    expect(zhCNMessages["memory.manualHistoryPathLabel"]).toBe("历史会话路径（可选）");
    expect(enUSMessages["memory.manualHistoryPathLabel"]).toBe("Conversation history path (optional)");
    expect(source).toContain('id="manual-agent-history-path"');
    expect(source).toContain("value={manualHistoryPath}");
    expect(source).toContain('launchManagedAgentTask(source, "connect", userProvidedDataPath || undefined)');
  });

  it("新增 Agent 立即写入页面状态，并在重新进入页面时从后端刷新", () => {
    const source = readFileSync(resolve(__dirname, "..", "..", "memory-sources-page.tsx"), "utf8");

    expect(source).toContain("dispatch(appActions.agentSourcesRefreshed([");
    expect(source).toContain(".listSources()");
    expect(source).toContain("if (active) dispatch(appActions.agentSourcesRefreshed(sources));");
  });

  it("未知 Agent 首次接入任务始终使用英文 Prompt", () => {
    const prompt = buildManagedAgentTaskPrompt({
      sourceId: "manual-1",
      displayName: "Aider",
      dataPath: "~/.aider"
    }, "connect");

    expect(prompt).toContain("$agent-memory-onboarding");
    expect(prompt).toContain("Use $agent-memory-onboarding for this cross-Agent memory task.");
    expect(prompt).toContain("This is an on-demand task launched by the cross-Agent button.");
    expect(prompt).toContain("If it is absent, report that the Agent was not found");
    expect(prompt).not.toMatch(/[\u3400-\u9fff]/u);
    expect(prompt).toContain('"operation": "connect"');
    expect(prompt).toContain('"source_id": "manual-1"');
    expect(prompt).not.toContain("sync_boundary_at");
  });

  it("把用户填写的历史会话路径作为候选路径交给 Memmy 验证", () => {
    const prompt = buildManagedAgentTaskPrompt({
      sourceId: "manual-1",
      displayName: "Aider",
      dataPath: MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH
    }, "connect", "  ~/.aider/history  ");

    expect(prompt).toContain('"data_path": "~/.aider/history"');
    expect(prompt).toContain("explicitly supplied by the user in the GUI");
    expect(prompt).toContain("inspect this scoped candidate first, and verify it before use");
    expect(prompt).toContain("ask for a corrected path instead of silently replacing it");
    expect(prompt).toContain("If Memmy runs on Windows and the Agent data lives in WSL");
    expect(prompt).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("未知 Agent 后续同步直接调用后端配方，不再启动 Agent 会话", () => {
    const source = readFileSync(resolve(__dirname, "..", "..", "memory-sources-page.tsx"), "utf8");

    expect(source).toContain(".syncManagedSource(source.sourceId)");
    expect(source).toContain("source.syncReady === true");
    expect(source).not.toContain('launchManagedAgentTask(source, "sync")');
  });

  it("未知 Agent GUI 文案同时提供中英文版本", () => {
    const keys = [
      "memory.addOtherAgent",
      "memory.addOtherAgentDescription",
      "memory.addTitle",
      "memory.confirmAndStart",
      "memory.manualAgentAiHint",
      "memory.manualHistoryPathLabel",
      "memory.manualPathHint",
      "memory.deleteAgent"
    ] as const;

    for (const key of keys) {
      expect(zhCNMessages[key]).toBeTruthy();
      expect(enUSMessages[key]).toBeTruthy();
      expect(zhCNMessages[key]).not.toBe(enUSMessages[key]);
    }
  });

  it("未知 Agent 的待发现占位符不会被当作历史目录", () => {
    const prompt = buildManagedAgentTaskPrompt({
      sourceId: "manual-1",
      displayName: "Aider",
      dataPath: MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH
    }, "connect");

    expect(prompt).not.toContain("data_path");
  });

  it("首次扫描不会沿用错误的旧同步边界", () => {
    const prompt = buildManagedAgentTaskPrompt({
      sourceId: "manual-1",
      displayName: "Kimi Work",
      dataPath: "~/Library/Application Support/kimi-desktop"
    }, "connect");

    expect(prompt).not.toContain("sync_boundary_at");
  });

  it("全量扫描确认页要求先选择扫描范围，不再展示二次勾选", () => {
    const source = readFileSync(resolve(__dirname, "..", "..", "memory-sources-page.tsx"), "utf8");

    expect(source).toContain("memory.deepScanTargetLabel");
    expect(source).toContain("memory.deepScanTargetAll");
    expect(source).toContain("FullScanTargetOption");
    expect(source).not.toContain("memory.deepScanConfirmAcknowledge");
    expect(source).not.toContain("memory.deepScanConfirmEstimate");
  });

  it("按原型密度格式化真实 Agent 路径和记忆数量", () => {
    expect(formatSourceDataPath("/Users/zongy/Library/Application Support/Cursor/User/workspaceStorage")).toBe(
      "~/Library/Application Support/Cursor/User/workspaceStorage"
    );
    expect(formatSourceDataPath("/Users/zongy/.codex/sessions")).toBe("~/.codex/sessions");
    expect(formatSourceDataPath("~/.claude")).toBe("~/.claude");
    expect(formatSourceMemoryCount(1161, (key, values) => `${key}:${values?.count}`)).toBe("memory.sourceMemoryCount:1,161");
  });

  it("从运行时 Memory URL 展示真实端口，不再写死旧地址", () => {
    expect(formatMemoryServiceAddress("http://127.0.0.1:18960")).toBe("127.0.0.1:18960");
    expect(formatMemoryServiceAddress("http://localhost:18888/")).toBe("localhost:18888");
    expect(formatMemoryServiceAddress(undefined)).toBeUndefined();
    expect(zhCNMessages["memory.restartService"]).toBe("重启服务");
    expect(zhCNMessages).not.toHaveProperty("memory.daemonAddress");
  });

  it("记忆服务帮助入口按应用版本打开对应官网文档", () => {
    expect(resolveMemoryDocsUrl("intl")).toBe("https://memmy.bot/docs/memory/overview/");
    expect(resolveMemoryDocsUrl("INTL")).toBe("https://memmy.bot/docs/memory/overview/");
    expect(resolveMemoryDocsUrl("cn")).toBe("https://memmy.cn/docs/memory/overview/");
    expect(resolveMemoryDocsUrl(undefined)).toBe("https://memmy.cn/docs/memory/overview/");

    const source = readFileSync(resolve(__dirname, "..", "..", "memory-sources-page.tsx"), "utf8");
    expect(source).toContain("openExternalUrl(resolveMemoryDocsUrl())");
    expect(zhCNMessages["memory.openDocs"]).toBe("查看记忆服务文档");
    expect(enUSMessages["memory.openDocs"]).toBe("View memory service documentation");
    expect(zhCNMessages["memory.learnMore"]).toBe("了解更多");
    expect(enUSMessages["memory.learnMore"]).toBe("Learn more");
  });

  it("接入源不可用时展示用户文案而不是 HTTP 调试信息", () => {
    const message = formatAgentSourceActionError(
      new ApiRequestError("Request /api/agent-sources/opencode/skill failed with status 500", 409, "agent_source_unavailable", "req-1"),
      {
        sourceId: "opencode",
        displayName: "Opencode",
        dataPath: "~/.local/share/opencode/opencode.db",
        builtin: true,
        available: false,
        status: "not_connected",
        messageCount: 0,
        lastScannedAt: null
      },
      (key, values) => `${key}:${values?.agent ?? ""}`
    );

    expect(message).toBe("memory.agentSourceUnavailable:Opencode");
    expect(message).not.toContain("/api/agent-sources/opencode/skill");
    expect(message).not.toContain("status 500");
  });

  it("扫描请求失败时通过本地化错误映射进入 GUI", () => {
    const source = readFileSync(resolve(__dirname, "..", "..", "memory-sources-page.tsx"), "utf8");

    expect(source).toContain("formatAgentSourceScanRequestError(error, scanSource, t)");
    expect(source).toContain("formatError: (error) =>");
  });

  it("暂停后的扫描进度尾部不重复显示已停止", () => {
    expect(formatScanProgressTail({
      jobId: "job-stopped",
      sourceId: "openclaw",
      phase: "stopped",
      current: 0,
      total: 0
    }, false, 0, (key) => key)).toBe("");
  });

  it("暂停后继续扫描沿用原 source 而不是回退全量扫描", () => {
    expect(resolveScanContinueSourceId({
      jobId: "job-openclaw",
      sourceId: "openclaw",
      phase: "stopped",
      current: 10,
      total: 20
    })).toBe("openclaw");
    expect(resolveScanContinueSourceId(null)).toBe("all");
    expect(resolveScanContinueSourceId({
      jobId: "job-running",
      sourceId: "openclaw",
      phase: "scan",
      current: 0,
      total: 0
    })).toBe("all");
  });

  it("按 Agent 类型固定接入按钮逻辑，避免回退到移除 Agent", () => {
    expect(resolveAgentSourceConnectionAction(createSource("openclaw", "not_connected"))).toBe("install_plugin");
    expect(resolveAgentSourceConnectionAction(createSource("hermes", "skill_installed"))).toBe("install_plugin");
    expect(resolveAgentSourceConnectionAction(createSource("hermes", "plugin_installed"))).toBe("remove_plugin");
    expect(resolveAgentSourceConnectionAction(createSource("deepseek_harness", "not_connected"))).toBe("install_plugin");
    expect(resolveAgentSourceConnectionAction(createSource("deepseek_harness", "plugin_installed"))).toBe("remove_plugin");
    expect(resolveAgentSourceConnectionAction(createSource("opencode", "plugin_installed"))).toBe("remove_plugin");
    expect(resolveAgentSourceConnectionAction(createSource("cursor", "not_connected"))).toBe("install_hook");
    expect(resolveAgentSourceConnectionAction(createSource("codex", "skill_installed"))).toBe("install_hook");
    expect(resolveAgentSourceConnectionAction(createSource("claude_code", "plugin_installed"))).toBe("remove_hook");
    expect(resolveAgentSourceConnectionAction(createSource("opencode", "not_connected"))).toBe("install_plugin");
    expect(resolveAgentSourceConnectionAction(createSource("opencode", "skill_installed"))).toBe("install_plugin");
    expect(resolveAgentSourceConnectionAction(createSource("workbuddy", "not_connected"))).toBe("install_skill");
    expect(resolveAgentSourceConnectionAction(createSource("workbuddy", "skill_installed"))).toBe("remove_skill");
    expect(resolveAgentSourceConnectionAction(createSource("pi", "not_connected"))).toBe("install_skill");
    expect(resolveAgentSourceConnectionAction(createSource("qwenwork", "skill_installed"))).toBe("remove_skill");
    expect(resolveAgentSourceConnectionAction({
      ...createSource("manual-1", "not_connected"),
      builtin: false
    })).toBe("delete_source");
  });

  it("未检测到 Agent 框架时禁用安装类接入按钮，但保留卸载按钮", () => {
    expect(isAgentSourceConnectionActionDisabled({ available: false }, "install_plugin")).toBe(true);
    expect(isAgentSourceConnectionActionDisabled({ available: false }, "install_hook")).toBe(true);
    expect(isAgentSourceConnectionActionDisabled({ available: false }, "install_skill")).toBe(true);
    expect(isAgentSourceConnectionActionDisabled({ available: false }, "remove_plugin")).toBe(false);
    expect(isAgentSourceConnectionActionDisabled({ available: true }, "install_plugin")).toBe(false);
  });

  it("按安装类型展示接入源状态，不再把未安装误写成未接入", () => {
    const source = readFileSync(resolve(__dirname, "..", "..", "memory-sources-page.tsx"), "utf8");

    expect(resolveAgentSourceStatusLabelKey(createSource("cursor", "not_connected"))).toBe("memory.hookNotInstalled");
    expect(resolveAgentSourceStatusLabelKey(createSource("claude_code", "not_connected"))).toBe("memory.hookNotInstalled");
    expect(resolveAgentSourceStatusLabelKey(createSource("codex", "not_connected"))).toBe("memory.hookNotInstalled");
    expect(resolveAgentSourceStatusLabelKey(createSource("openclaw", "not_connected"))).toBe("memory.pluginNotInstalled");
    expect(resolveAgentSourceStatusLabelKey(createSource("opencode", "not_connected"))).toBe("memory.pluginNotInstalled");
    expect(resolveAgentSourceStatusLabelKey(createSource("codex", "skill_installed"))).toBe("memory.skillInstalled");
    expect(resolveAgentSourceStatusLabelKey(createSource("cursor", "plugin_installed"))).toBe("memory.hookInstalled");
    expect(resolveAgentSourceStatusLabelKey(createSource("claude_code", "plugin_installed"))).toBe("memory.hookInstalled");
    expect(resolveAgentSourceStatusLabelKey(createSource("codex", "plugin_installed"))).toBe("memory.hookInstalled");
    expect(resolveAgentSourceStatusLabelKey(createSource("hermes", "plugin_installed"))).toBe("memory.pluginInstalled");
    expect(resolveAgentSourceStatusLabelKey(createSource("opencode", "plugin_installed"))).toBe("memory.pluginInstalled");
    expect(resolveAgentSourceStatusLabelKey(createSource("workbuddy", "not_connected"))).toBe("memory.skillNotInstalled");
    expect(resolveAgentSourceStatusLabelKey(createSource("pi", "not_connected"))).toBe("memory.skillNotInstalled");
    expect(resolveAgentSourceStatusLabelKey(createSource("qwenwork", "skill_installed"))).toBe("memory.skillInstalled");
    expect(source).toContain('props.source.status === "skill_installed" || props.source.status === "plugin_installed"');
    expect(source).not.toContain("memory.notConnected");
  });
});

function createSource(sourceId: string, status: "not_connected" | "skill_installed" | "plugin_installed") {
  return {
    sourceId,
    displayName: sourceId,
    dataPath: `/tmp/${sourceId}`,
    builtin: true,
    available: true,
    status,
    messageCount: 0,
    lastScannedAt: null
  };
}
