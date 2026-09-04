/** Settings page tests. */
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ModelConfigView } from "@memmy/local-api-contracts";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";
import { appActions } from "../../state/app-actions.js";
import { appReducer, createInitialAppState, type AppState } from "../../state/app-reducer.js";
import { createModelWorkspace, modelConfigInput, upsertModelConnection } from "../../state/model-workspace.js";
import type { UpdateCoordinatorValue } from "../../app/update-coordinator.js";
import {
  LOG_LEVEL_STORAGE_KEY,
  SettingsPageView,
  finalizeAccountLogout,
  formatUsageUpdatedAt,
  hasConfiguredByokAgentModel,
  isPendingQuotaRequestError,
  resolveQuotaEligibilityMessage,
  resolveSettingsTabFromHash,
  readLogLevel,
  shouldSaveAccountNicknameOnKeyDown,
  writeLogLevel
} from "../settings-page.js";
import { formatMessage, zhCNMessages } from "../../i18n/messages.js";
import {
  availableConnectionProtocols,
  editorProtocolForCapabilities,
  modelCapabilitiesForKind,
  normalizeEditorCapabilities
} from "../model-workspace-section.js";

const settingsPageSourcePath = fileURLToPath(new URL("../settings-page.tsx", import.meta.url));
const updateCoordinatorSourcePath = fileURLToPath(new URL("../../app/update-coordinator.tsx", import.meta.url));
const browserUpdateSourcePath = fileURLToPath(new URL("../../app/browser-update.ts", import.meta.url));
const tokenUsageStylesPath = fileURLToPath(new URL("../settings-token-usage.module.css", import.meta.url));
const modelConfigSourcePath = fileURLToPath(new URL("../model-config.ts", import.meta.url));
const modelWorkspaceSourcePath = fileURLToPath(new URL("../model-workspace-section.tsx", import.meta.url));
const overflowTooltipSourcePath = fileURLToPath(new URL("../../components/overflow-tooltip-text.tsx", import.meta.url));

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

describe("多 BYOK endpoint 入口", () => {
  it("同 Provider 可继续添加不同协议 endpoint", () => {
    const available = availableConnectionProtocols([
      {
        id: "openai-1",
        provider: "openai",
        endpointId: "openai-chat",
        endpoint: "https://api.openai.com/v1",
        protocol: "openai-chat-completions",
        apiKeyMasked: "••••1234",
        models: ["gpt-4o"],
        modelEntries: [{ presetId: "preset-openai", model: "gpt-4o", capability: "chat", capabilities: ["agent"] }],
        modelCapabilities: { "gpt-4o": "chat" },
        presetIds: { "gpt-4o": "preset-openai" },
        available: true,
        accountManaged: false
      },
      {
        id: "anthropic-1",
        provider: "anthropic",
        endpointId: "anthropic-chat",
        endpoint: "https://api.anthropic.com",
        protocol: "anthropic-messages",
        apiKeyMasked: "••••5678",
        models: ["claude-sonnet-4"],
        modelEntries: [{ presetId: "preset-anthropic", model: "claude-sonnet-4", capability: "chat", capabilities: ["agent"] }],
        modelCapabilities: { "claude-sonnet-4": "chat" },
        presetIds: { "claude-sonnet-4": "preset-anthropic" },
        available: true,
        accountManaged: false
      }
    ]);

    expect(available).toContain("openai");
    expect(available).toContain("anthropic");
    expect(available[0]).toBe("openai");
  });
});

describe("自定义模型能力选择", () => {
  it("四种单选类型映射为对应的底层能力", () => {
    expect(modelCapabilitiesForKind("text")).toEqual(["chat", "memorySummary", "memoryEvolution"]);
    expect(modelCapabilitiesForKind("embedding")).toEqual(["embedding"]);
    expect(modelCapabilitiesForKind("asr")).toEqual(["asr"]);
    expect(modelCapabilitiesForKind("image")).toEqual(["image"]);
  });

  it("旧文本用途进入编辑器时统一归一化为通用文本", () => {
    expect(normalizeEditorCapabilities(["chat"])).toEqual(["chat", "memorySummary", "memoryEvolution"]);
    expect(normalizeEditorCapabilities(["memorySummary"])).toEqual(["chat", "memorySummary", "memoryEvolution"]);
    expect(normalizeEditorCapabilities(["memoryEvolution"])).toEqual(["chat", "memorySummary", "memoryEvolution"]);
    expect(normalizeEditorCapabilities(["embedding"])).toEqual(["embedding"]);
    expect(normalizeEditorCapabilities(["asr"])).toEqual(["asr"]);
    expect(normalizeEditorCapabilities(["image"])).toEqual(["image"]);
  });

  it("四种编辑器类型保存为精确的 catalog 能力", () => {
    const cases = [
      ["text", "openai-chat-completions", ["agent", "memory_summary", "memory_evolution"]],
      ["embedding", "openai-embeddings", ["embedding"]],
      ["asr", "dashscope-input-audio-chat", ["asr"]],
      ["image", "openai-images", ["image_generation"]]
    ] as const;

    for (const [kind, protocol, expectedCapabilities] of cases) {
      const capabilities = modelCapabilitiesForKind(kind);
      const result = upsertModelConnection(createModelWorkspace(null), "byok", {
        provider: "openai",
        endpoint: "https://example.com/v1",
        protocol,
        apiKey: "sk-test",
        models: [`custom-${kind}`],
        modelEntries: [{
          model: `custom-${kind}`,
          capability: capabilities[0]!,
          capabilities
        }]
      });

      expect(result.error).toBeNull();
      expect(modelConfigInput(result.workspace).providers[0]?.models[0]?.capabilities).toEqual(expectedCapabilities);
    }
  });

  it("编辑模型切换类型时同步切换 endpoint 协议", () => {
    const textCapabilities = modelCapabilitiesForKind("text");
    const created = upsertModelConnection(createModelWorkspace(null), "byok", {
      provider: "openai",
      endpoint: "https://example.com/v1",
      protocol: "openai-chat-completions",
      apiKey: "sk-test",
      models: ["custom-model"],
      modelEntries: [{ model: "custom-model", capability: "chat", capabilities: textCapabilities }]
    });
    const connection = created.workspace.spaces.byok.connections[0]!;
    const embeddingCapabilities = modelCapabilitiesForKind("embedding");
    const protocol = editorProtocolForCapabilities("openai", embeddingCapabilities, connection.protocol);
    const edited = upsertModelConnection(created.workspace, "byok", {
      id: connection.id,
      provider: "openai",
      endpoint: connection.endpoint,
      protocol,
      apiKeyMasked: connection.apiKeyMasked,
      models: ["custom-model"],
      modelEntries: [{
        presetId: connection.modelEntries[0]!.presetId,
        model: "custom-model",
        capability: "embedding",
        capabilities: embeddingCapabilities
      }]
    });

    expect(protocol).toBe("openai-embeddings");
    expect(edited.error).toBeNull();
    expect(modelConfigInput(edited.workspace).providers[0]?.endpoints[0]?.protocol).toBe("openai-embeddings");
    expect(modelConfigInput(edited.workspace).providers[0]?.models[0]?.capabilities).toEqual(["embedding"]);
    expect(editorProtocolForCapabilities("openai", textCapabilities, "openai-responses")).toBe("openai-responses");
    expect(editorProtocolForCapabilities("qwen", ["image"])).toBe("dashscope-multimodal-generation");
  });

  it("模型能力沿用标准 Select 四选一，不再拆分文本用途", () => {
    const source = readFileSync(modelWorkspaceSourcePath, "utf8");

    expect(source).toContain('const MODEL_KIND_OPTIONS = ["text", "embedding", "asr", "image"] as const;');
    expect(source).toContain("value={kind}");
    expect(source).toContain("options={modelKindOptions(t)}");
    expect(source).toContain("onValueChange={(value) => props.onChange(modelCapabilitiesForKind(value as ModelKind))}");
    expect(source).toContain('className="select-control--subtle model-capability-select"');
    expect(source.match(/t\("settings\.modelWorkspace\.modelCapability"\)/g)).toHaveLength(1);
    expect(source).toContain("normalizeEditorCapabilities(entry.capabilities.map(fromCatalogCapability))");
    expect(source).not.toContain('type="checkbox"');
    expect(source).not.toContain('t("settings.modelWorkspace.textRoles")');
    expect(source).not.toContain('t("settings.modelWorkspace.capability.agent")');
  });
});

describe("日志级别本地持久化", () => {
  it("未写入时回退到默认 info", () => {
    expect(readLogLevel(createMemoryStorage())).toBe("info");
  });

  it("SSR 无 storage 时回退到默认 info", () => {
    expect(readLogLevel(undefined)).toBe("info");
  });

  it("写入后再读取返回同一选择", () => {
    const storage = createMemoryStorage();
    writeLogLevel(storage, "debug");
    expect(storage.getItem(LOG_LEVEL_STORAGE_KEY)).toBe("debug");
    expect(readLogLevel(storage)).toBe("debug");
  });

  it("非法持久化值回退到默认 info", () => {
    const storage = createMemoryStorage();
    storage.setItem(LOG_LEVEL_STORAGE_KEY, "verbose");
    expect(readLogLevel(storage)).toBe("info");
  });
});

describe("formatUsageUpdatedAt", () => {
  it("按本地时区格式化(而非直接显示 UTC)", () => {
    const iso = "2026-06-17T09:53:00.000Z";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    const expectedLocal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(formatUsageUpdatedAt(iso)).toBe(expectedLocal);
    // Regression: it must not be the old implementation's "truncate the ISO string" result (which would display UTC).
    if (d.getTimezoneOffset() !== 0) {
      expect(formatUsageUpdatedAt(iso)).not.toBe("2026-06-17 09:53");
    }
  });

  it("非法输入原样返回", () => {
    expect(formatUsageUpdatedAt("not-a-date")).toBe("not-a-date");
  });
});

describe("resolveSettingsTabFromHash", () => {
  it("把设置深链 hash 映射到对应 Tab", () => {
    expect(resolveSettingsTabFromHash("#account")).toBe("account");
    expect(resolveSettingsTabFromHash("#pet-avatar")).toBe("preferences");
    expect(resolveSettingsTabFromHash("#preferences")).toBe("preferences");
    expect(resolveSettingsTabFromHash("#model-config")).toBe("model");
    expect(resolveSettingsTabFromHash("#model-config-add")).toBe("model");
    expect(resolveSettingsTabFromHash("#token-usage")).toBe("tokens");
    expect(resolveSettingsTabFromHash("#about")).toBe("about");
    expect(resolveSettingsTabFromHash("#unknown")).toBeNull();
  });
});

describe("SettingsPageView", () => {
  it("国际版首次安装时将未配置的 system 语言显示为 English", () => {
    const state = appReducer(
      createInitialAppState(),
      appActions.bootstrapLoaded(mockBootstrap, "/settings")
    );
    const html = normalizeSsrHtml(renderSettingsPageView(state, "en-US"));

    expect(html).toMatch(/select-control__value[^>]*>English<\/span>/);
    expect(html).not.toMatch(/select-control__value[^>]*>中文<\/span>/);
  });

  it("对齐 Memmy v2.0 设置页卡片结构和关键内容", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createReadyState()));

    expect(html).toContain("app-frame-page-content max-w-2xl mx-auto py-8");
    expect(html).toContain('id="settings-panel-account"');
    expect(html).toContain('id="settings-panel-model"');
    expect(html).toContain('id="settings-panel-tokens"');
    expect(html).toContain('id="settings-panel-preferences"');
    expect(html).toContain('id="settings-panel-about"');
    expect(html).not.toContain("settings-tabs");
    expect(html).toContain("bg-background-paper rounded-card-lg border-content-panel p-6");
    expect(html).toContain("账户");
    expect(html).toContain("Token 用量");
    expect(html).toContain("模型库");
    expect(html).toContain("通用");
    expect(html).toContain("启动与窗口");
    expect(html).toContain("通知");
    expect(html).toContain("隐私");
    expect(html).toContain("高级 / 开发者");
    expect(html).toContain("关于");
    expect(html).toContain("g***@example.com");
    expect(html).not.toContain("grace@example.com");
    expect(html).toContain("注册时间：2026-04-12");
    expect(html).toContain("平台赠送额度");
    expect(html).toContain(">1.4M</strong><span>/</span><span>5M</span><em>Token</em>");
    expect(html).toContain("自定义 API Key 消耗");
    expect(html).not.toContain("查看用量详情");
    expect(html).toContain("select-control--compact select-control--subtle");
    expect(html).toContain('role="combobox"');
  });

  it("设置页按账户 / 模型配置 / Token 用量 / 偏好 / 关于拆成五个面板", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createReadyState()));
    const accountPanel = html.indexOf('id="settings-panel-account"');
    const modelPanel = html.indexOf('id="settings-panel-model"');
    const tokensPanel = html.indexOf('id="settings-panel-tokens"');
    const preferencesPanel = html.indexOf('id="settings-panel-preferences"');
    const aboutPanel = html.indexOf('id="settings-panel-about"');

    expect(accountPanel).toBeGreaterThanOrEqual(0);
    expect(modelPanel).toBeGreaterThan(accountPanel);
    expect(tokensPanel).toBeGreaterThan(modelPanel);
    expect(preferencesPanel).toBeGreaterThan(tokensPanel);
    expect(aboutPanel).toBeGreaterThan(preferencesPanel);
  });

  it("按 2026-06-09 原型让模型配置排在 Token 用量之前", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createReadyState()));
    const modelIndex = html.indexOf('id="model-config"');
    const usageIndex = html.indexOf('id="token-usage"');

    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(modelIndex).toBeLessThan(usageIndex);
  });

  it("使用原型 SettingsPage 的 lucide 图标而不是字母占位", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createReadyState()));

    expect(html).toContain("lucide-user");
    expect(html).toContain("lucide-zap");
    expect(html).toContain("lucide-database");
    expect(html).toContain("lucide-wrench");
    expect(html).toContain("lucide-palette");
    expect(html).toContain("lucide-rocket");
    expect(html).toContain("lucide-shield");
    expect(html).not.toContain('class="settings-page-title-mark">S</span>');
    expect(html).not.toContain('class="settings-card-icon">U</span>');
    expect(html).not.toContain('class="settings-card-icon">T</span>');
    expect(html).not.toContain('class="settings-card-icon">M</span>');
    expect(html).not.toContain('class="settings-card-icon">G</span>');
    expect(html).not.toContain('class="settings-card-icon">W</span>');
    expect(html).not.toContain('class="settings-card-icon">P</span>');
  });

  it("隐私与改进计划的了解更多跳系统浏览器打开数据协议外链", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(source).toContain('t("settings.privacy.learnMore")');
    expect(source).toContain('openExternalUrl(getLegalLinkUrl("data", language, bootstrap?.legal))');
    expect(source).not.toContain('appActions.navigate("/data-use")');
  });

  it("共享数据开关点击立即乐观翻转徽标并保留选择，后端失败不回弹", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    // The click first dispatches an optimistic update; the badge/button text flips immediately without waiting for the backend response.
    expect(source).toContain("dispatch(appActions.privacyUpdated(patch));");
    // In local/logged-out state the backend does not persist privacy and throws; swallow the error, keep the optimistic result, and do not roll back.
    expect(source).toContain(".catch(");
    expect(source).not.toContain("const previousPrivacy = privacySettings;");
  });

  it("隐私与改进计划使用滑块开关而不是开启关闭文本按钮", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(source).toContain("allowMemoryImprovementUpload: checked");
    expect(source).toContain('ariaLabel={t("settings.privacy.shareData")}');
    expect(source).not.toContain('{improvementPlan ? t("settings.privacy.turnOff") : t("settings.privacy.turnOn")}');
  });

  it("关于区服务协议入口跳系统浏览器打开服务协议外链", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(source).toContain('t("settings.about.terms")');
    expect(source).toContain('openExternalUrl(getLegalLinkUrl("terms", language, bootstrap?.legal))');
    expect(source).not.toContain('appActions.navigate("/terms")');
    expect(source).not.toContain('<LinkButton label={t("settings.about.terms")} href="#" />');
  });

  it("关于区只消费应用级更新状态，下载和弹窗不随页面卸载", () => {
    const settingsSource = readFileSync(settingsPageSourcePath, "utf8");
    const coordinatorSource = readFileSync(updateCoordinatorSourcePath, "utf8");
    const browserSource = readFileSync(browserUpdateSourcePath, "utf8");

    expect(settingsSource).toContain("const update = useUpdateCoordinator();");
    expect(settingsSource).toContain("update={update}");
    expect(settingsSource).toContain("onClick={() => void update.requestPrimaryAction()}");
    expect(settingsSource).toContain("resolveUpdateButtonLabel(update.phase, t)");
    expect(settingsSource).toContain("Memmy v{update.appVersion}");
    expect(settingsSource).not.toContain("desktopBridge.checkForUpdates()");
    expect(settingsSource).not.toContain("desktopBridge.downloadUpdate");
    expect(settingsSource).not.toContain("setPendingUpdate");
    expect(settingsSource).not.toContain("setPreparedUpdatePath");

    expect(coordinatorSource).toContain("export function UpdateCoordinatorProvider");
    expect(coordinatorSource).toContain("bridge.downloadUpdate(update, { openInstaller: false })");
    expect(coordinatorSource).toContain('phase: "prepared"');
    expect(coordinatorSource).toContain('dialog: "install-confirm"');
    expect(coordinatorSource).toContain("preparedUpdatePath: installResult.filePath");
    expect(coordinatorSource).toContain('current.phase === "prepared"');
    expect(coordinatorSource).toContain('dialog: "install-confirm"');
    expect(coordinatorSource).toContain("bridge.openUpdateInstaller(preparedPath)");
    expect(coordinatorSource).toContain("bridge.notifyUpdateAvailable");
    expect(coordinatorSource).toContain("isForegroundUpdateFlow(updateStateRef.current)");

    expect(browserSource).toContain("function readBrowserUpdateEnvelopeManifest");
    expect(browserSource).toContain("manifest.code !== 0");
    expect(browserSource).toContain('readUpdateManifestRecord(manifest, "data") ?? {}');
    expect(browserSource).toContain('url.searchParams.set("platformType", resolveBrowserUpdatePlatformType())');
    expect(browserSource).toContain('resolveDesktopAccountChannel() === "email" ? "intl" : "cn"');
    expect(browserSource).toContain('import.meta.env.MEMMY_PACKAGE_SIGNING === "unsigned" ? "unsigned" : "signed"');
    expect(browserSource).toContain('const UPDATE_MANIFEST_PATH = "/api/memmy/desktop/latest"');
    expect(browserSource).not.toContain("VITE_MEMMY_UPDATE_MANIFEST_URL");
  });

  it("安装包准备好且用户关闭弹窗后，设置页仍显示重启安装", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(
      createReadyState(),
      "zh-CN",
      createUpdateViewModel({
        phase: "prepared",
        preparedUpdatePath: "/tmp/Memmy-update.dmg"
      })
    ));

    expect(html).toContain("Memmy v2.1.0");
    expect(html).toContain("重启安装");
    expect(html).not.toContain("检查更新");
  });

  it("下载更新时在关于区展示下载进度条", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(
      createReadyState(),
      "zh-CN",
      createUpdateViewModel({
        phase: "downloading",
        downloadProgress: {
          downloadUrl: "https://updates.example.com/Memmy.dmg",
          filePath: "/tmp/Memmy.dmg",
          transferredBytes: 524_288,
          totalBytes: 1_048_576,
          percent: 50
        }
      })
    ));

    expect(html).toContain("下载中");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="下载进度"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("已下载 50%");
    expect(html).toContain("512.0 KB / 1.0 MB");
  });

  it("菜单栏图标开关保存到应用设置并同步桌面 bridge", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(source).toContain("appSettings?.menuBarIconEnabled");
    expect(source).toContain("configClient?.updateSettings({ menuBarIconEnabled: enabled })");
    expect(source).toContain("window.memmy?.setMenuBarIcon(savedEnabled)");
    expect(source).toContain("onChange={handleMenuBarIconChange}");
  });

  it("Windows 端使用 Windows 状态栏提示文案", () => {
    const windowsHtml = normalizeSsrHtml(renderSettingsPageView(createReadyState(), "zh-CN", createUpdateViewModel(), "win32"));
    const windowsEnglishHtml = normalizeSsrHtml(renderSettingsPageView(createReadyState(), "en-US", createUpdateViewModel(), "win32"));
    const macHtml = normalizeSsrHtml(renderSettingsPageView(createReadyState(), "zh-CN", createUpdateViewModel(), "darwin"));

    expect(windowsHtml).toContain("在 Windows 状态栏常驻 Memmy 图标，便于随时呼出");
    expect(windowsHtml).not.toContain("在 macOS 状态栏常驻 Memmy 图标，便于随时呼出");
    expect(windowsEnglishHtml).toContain("Keep a Memmy icon in the Windows system tray for quick access");
    expect(windowsEnglishHtml).not.toContain("Keep a Memmy icon in the macOS status bar for quick access");
    expect(macHtml).toContain("在 macOS 状态栏常驻 Memmy 图标，便于随时呼出");
  });

  it("日志级别下拉选择走 handleLogLevelChange 持久化到 localStorage 与主进程 IPC", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    // onChange must be wired to the persisting function, which internally writes localStorage and calls window.memmy?.setLogLevel.
    expect(source).toContain("onChange={handleLogLevelChange}");
    // Regression point: it must not only update in-memory state; otherwise the mount effect reads the old value back from the main process after a page switch/reload, causing a "snap-back".
    expect(source).not.toContain("onChange={(value) => setLogLevel(value as LogLevel)}");
  });

  it("高级开发者按钮接入桌面诊断 bridge 并展示操作反馈", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(source).toContain("function openDeveloperLogs()");
    expect(source).toContain("function exportDiagnosticsReport()");
    expect(source).toContain("function downloadDiagnosticsReportInBrowser(");
    expect(source).toContain("function buildRendererDiagnosticsReport(");
    expect(source).toContain("window.memmy?.openLogsDirectory");
    expect(source).toContain("window.memmy?.exportDiagnosticsReport");
    expect(source).toContain("downloadDiagnosticsReportInBrowser");
    expect(source).toContain("onClick={openDeveloperLogs}");
    expect(source).toContain("onClick={exportDiagnosticsReport}");
    expect(source).toContain('t("settings.developer.openLogsUnavailable")');
    expect(source).toContain('t("settings.developer.exportDiagnosticsDone"');
    expect(source).not.toContain('setDeveloperFeedback({ tone: "error", message: t("settings.developer.exportDiagnosticsUnavailable") });');
  });

  it("注册用户平台 Token 态对齐 PRD 的原型数据和状态", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createReadyState()));

    expect(html).toContain("g***@example.com");
    expect(html).not.toContain("grace@example.com");
    expect(html).toContain("注册时间：2026-04-12");
    expect(html).toContain("桌宠模式");
    expect(html).toContain("中文");
    expect(html).not.toContain("<select");
    expect(html).toContain("已关闭行为数据收集");
    expect(html).toContain(">1.4M</strong><span>/</span><span>5M</span><em>Token</em>");
    expect(html).not.toContain("已使用 0 Token");
    expect(html).not.toContain("System");
    expect(html).not.toContain("注册于");
  });

  it("Token 用量不再展示计划总额概览", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createImprovementBonusState()));

    expect(html).toContain("自定义 API Key 消耗");
    expect(html).not.toContain("赠送大模型额度已用");
    expect(html).not.toContain("共 30.3M Token");
    expect(html).not.toContain("剩余 30.3M Token");
  });

  it("注册时间只展示年月日", () => {
    const state = appReducer(
      createAccountModeState(),
      appActions.accountUpdated({ registeredAt: "2026-06-08T15:20:30.000Z" })
    );
    const html = normalizeSsrHtml(renderSettingsPageView(state));

    expect(html).toContain("注册时间：2026-06-08");
    expect(html).not.toContain("15:20");
    expect(html).not.toContain("15:20:30");
  });

  it("删除设置页桌宠形象入口", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createReadyState()));

    expect(html).toContain('id="pet-avatar"');
    expect(html).not.toContain("桌宠形象");
    expect(html).not.toContain("上传新形象");
    expect(html).not.toContain("本月剩余 3/3 次");
  });

  it("注册账号模式展示平台模型和独立自定义模型工作区", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createAccountModeState()));
    const modelConfigHtml = html.slice(html.indexOf('id="model-config"'), html.indexOf('id="token-usage"'));

    expect(html).toContain("g***@example.com");
    expect(html).not.toContain("grace@example.com");
    expect(html).toContain("注册时间：2026-04-12");
    expect(html).toContain("修改昵称");
    expect(html).toContain("Token 用量");
    expect(modelConfigHtml).toContain("模型库");
    expect(modelConfigHtml).toContain("平台提供");
    expect(modelConfigHtml).toContain("Memmy Platform");
    expect(modelConfigHtml).toContain("通用文本");
    expect(modelConfigHtml).toContain("添加配置");
    expect(modelConfigHtml).toContain("Agent 任务模型");
    expect(modelConfigHtml).toContain("Memmy Platform · ASR");
    expect(modelConfigHtml).not.toContain("为语音识别 ASR选择模型 Memmy Platform · 通用文本");
    expect(html).toContain("平台赠送额度");
    expect(html).toContain("自定义 API Key 消耗");
    expect(html).not.toContain("查看用量详情");
    expect(modelConfigHtml).not.toContain("当前模式：");
    expect(modelConfigHtml).not.toContain("切换为自定义 API Key");
    expect(modelConfigHtml).not.toContain("默认任务模型");
  });

  it("设置页不再展示全局平台与自有模型模式切换", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createAccountModeState()));
    const modelConfigStart = html.indexOf('id="model-config"');
    const tokenUsageStart = html.indexOf('id="token-usage"');
    const modelConfigHtml = html.slice(modelConfigStart, tokenUsageStart);

    expect(modelConfigHtml).toContain("模型库");
    expect(modelConfigHtml).not.toContain("当前模式：");
    expect(modelConfigHtml).not.toContain("平台赠送 Token");
    expect(modelConfigHtml).not.toContain("切换为自定义 API Key");
    expect(modelConfigHtml).not.toContain("切换回平台 Token");
    expect(modelConfigHtml).not.toContain("默认任务模型");
  });

  it("手机号注册账号区展示手机号，邮箱注册账号区展示邮箱", () => {
    const phoneHtml = normalizeSsrHtml(renderSettingsPageView(createPhoneAccountModeState()));
    const emailHtml = normalizeSsrHtml(renderSettingsPageView(createAccountModeState()));

    expect(phoneHtml).toContain("138****8000");
    expect(phoneHtml).not.toContain("13800138000");
    expect(phoneHtml).not.toContain("未绑定邮箱");
    expect(emailHtml).toContain("g***@example.com");
    expect(emailHtml).not.toContain("grace@example.com");
  });

  it("注册账号缺少账号标识时不误提示未绑定邮箱", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createAccountModeWithoutIdentifierState()));

    expect(html).toContain("未绑定手机号或邮箱");
    expect(html).not.toContain("未绑定邮箱");
  });

  it("注册账号即使已有本地配置也保持账号与本地自定义模型隔离", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createAccountModeWithSavedModelState()));
    const modelConfigHtml = html.slice(html.indexOf('id="model-config"'), html.indexOf('id="token-usage"'));

    expect(html).toContain("g***@example.com");
    expect(html).not.toContain("grace@example.com");
    expect(html).toContain("注册时间：2026-04-12");
    expect(html).toContain("Token 用量");
    expect(modelConfigHtml).toContain("模型库");
    expect(modelConfigHtml).toContain("Memmy Platform");
    expect(modelConfigHtml).toContain("平台提供");
    expect(modelConfigHtml).toContain("添加配置");
    expect(modelConfigHtml).toContain("main-model");
    expect(modelConfigHtml).not.toContain("切换为自定义 API Key");
    expect(modelConfigHtml).not.toContain("默认任务模型");
    expect(html).not.toContain("本地模式");
    expect(html).not.toContain("无需注册账号");
  });

  it("账号模式模型配置使用统一模型工作区，不再挂旧模式切换表单", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(source).toContain("<ModelWorkspaceSection");
    expect(source).toContain("mode={workspaceMode}");
    expect(source).toContain("seedConfig={state.modelConfig}");
    expect(source).not.toContain("{false &&");
    expect(source).not.toContain("setForcedModelMode");
    expect(source).not.toContain('navigate("/api-key")');
    expect(source).not.toContain('onClick={handleSwitchToCustom}');
  });

  it("Token 用量直接展示平台与自定义用量明细", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");
    const styles = readFileSync(tokenUsageStylesPath, "utf8");

    expect(source).toContain("configClient.getTokenUsage()");
    expect(source).toContain("dispatch(appActions.tokenUsageUpdated(tokenUsage))");
    expect(source).toContain("requestAccountInvitation(accountClient, accountKey)");
    expect(source).not.toContain("resolveDisplayInviteCode");
    expect(source).toContain('t("settings.token.invite.title")');
    expect(source).toContain("usageStyles.invitationCard");
    expect(styles).toContain(".invitationCard");
    const compactStyles = styles.slice(styles.indexOf("@media (max-width: 640px)"));
    expect(compactStyles).toContain("grid-template-columns: auto minmax(0, 1fr)");
    expect(compactStyles).toContain("grid-column: 2");
    expect(compactStyles).toContain("flex-wrap: wrap");
    expect(source).toContain("byokTokenUsageClient.getSummary");
    expect(source).toContain("EMPTY_BYOK_TOKEN_USAGE");
    expect(source).not.toContain("function ChannelStat");
    expect(source).toContain("function UsageDetails");
    expect(source).toContain("function PlatformQuotaRow");
    expect(source).toContain("function ByokUsageRow");
    expect(source).toContain("function UsageSectionHead");
    expect(source).toContain("function formatTokenSummary");
    expect(source).toContain('return abbreviated === "0.0M" ? formatTokens(value) : abbreviated;');
    expect(source).toContain('import usageStyles from "./settings-token-usage.module.css";');
    expect(source).toContain("usageStyles.detailContent");
    expect(source).not.toContain("usageStyles.detailPage");
    expect(source).toContain("usageStyles.platformQuotaList");
    expect(source).toContain("usageStyles.byokUsageList");
    expect(source).toContain("usageStyles.usageSection");
    expect(source).toContain("usageStyles.quotaNumbers");
    expect(source).toContain("usageStyles.meter");
    expect(styles).toContain(".platformQuotaList");
    expect(styles).toContain(".byokUsageList");
    expect(styles).not.toContain(".backButton");
    expect(source).toContain("const byokUsageByKind = TOKEN_USAGE_SCENES.map");
    expect(source).toContain("const classifiedByokModels = props.byokUsage.byModel.filter");
    expect(source).toContain("const uniqueByokModels = new Map<string, ByokTokenUsageByModel>();");
    expect(source).not.toContain("function ByokModelUsageRow");
    expect(source).not.toContain("usageStyles.byokPurposeTitle");
    expect(styles).not.toContain(".byokPurposeTitle");
    expect(source).not.toContain('t("settings.token.byModel")');
    expect(source).not.toContain('t("settings.token.byPurpose")');
    expect(source).not.toContain('t("settings.token.historicalUnclassified")');
    expect(source).not.toContain("getTaskModelCandidates(workspace, workspaceMode)");
    expect(source).toContain('"settings.token.modelBreakdownPending"');
    expect(source).toContain("usageSceneMeta(props.usage.scene, t)");
    expect(source).not.toContain("updateShowUsageDetail");
    expect(source).not.toContain("showUsageDetail");
    expect(source).not.toContain("settings.token.viewDetail");
    expect(source).toContain('t("settings.token.input")');
    expect(source).toContain('t("settings.token.output")');
    expect(source).toContain('t("settings.token.cacheHit")');
    expect(source).not.toContain("meta.barClass");
  });

  it("模型工作区测试连接按钮固定位置和尺寸，状态提示展示在按钮左侧", () => {
    const workspaceSource = readFileSync(fileURLToPath(new URL("../model-workspace-section.tsx", import.meta.url)), "utf8");
    const fieldsSource = readFileSync(fileURLToPath(new URL("../api-key-form-fields.tsx", import.meta.url)), "utf8");

    expect(fieldsSource).toContain("inline-flex w-[112px] h-10 shrink-0 items-center justify-center px-4");
    expect(fieldsSource).toContain('<CheckCircle2 size={13} className="shrink-0" aria-hidden="true" />');
    expect(fieldsSource).toContain('<XCircle size={13} className="shrink-0" aria-hidden="true" />');
    expect(workspaceSource).toContain("model-connection-modal__footer-actions");
    expect(workspaceSource).toContain("<ApiKeyTestButton");
    expect(workspaceSource).toContain("editorTest.message");
    expect(workspaceSource).toContain("testEditorConnection");
  });

  it("模型工作区协议默认地址与模型配置常量保持一致", () => {
    const workspaceSource = readFileSync(fileURLToPath(new URL("../model-workspace-section.tsx", import.meta.url)), "utf8");
    const modelSource = readFileSync(modelConfigSourcePath, "utf8");

    const defaults = [
      ["openai", "https://api.openai.com/v1", "gpt-4o"],
      ["anthropic", "https://api.anthropic.com", "claude-sonnet-4"],
      ["gemini", "https://generativelanguage.googleapis.com", "gemini-2.5-pro"],
      ["deepseek", "https://api.deepseek.com/v1", "deepseek-chat"],
      ["zhipu", "https://open.bigmodel.cn/api/paas/v4", "glm-4"],
      ["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-max"],
      ["moonshot", "https://api.moonshot.ai/v1", "moonshot-v1-128k"],
      ["minimax", "https://api.minimax.chat/v1", "MiniMax-Text-01"],
      ["baidu", "https://qianfan.baidubce.com/v2", "ernie-x1.1"],
      ["doubao", "https://ark.cn-beijing.volces.com/api/v3", "doubao-pro-256k"]
    ];

    for (const [protocol, endpoint, placeholder] of defaults) {
      expect(modelSource).toContain(`${protocol}: "${endpoint}"`);
      expect(modelSource).toContain(`${protocol}: "${placeholder}"`);
    }

    expect(workspaceSource).toContain("endpoint: DEFAULT_ENDPOINTS[provider]");
    expect(workspaceSource).toContain("modelDraft: DEFAULT_MODEL_IDS[provider]");
    expect(workspaceSource).toContain("endpoint: DEFAULT_ENDPOINTS[provider]");
    expect(workspaceSource).toContain("modelDraft: DEFAULT_MODEL_IDS[provider]");
    expect(modelSource).toContain("endpoint: DEFAULT_ENDPOINTS[protocol]");
    expect(modelSource).toContain('modelId: ""');
    expect(modelSource).toContain('apiKey: ""');
    expect(modelSource).not.toContain("DEFAULT_MODEL_PLACEHOLDER");
  });

  it("本地模式账户区提供登录入口且不再提供退出操作", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createByokModeState()));
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(html).toContain("未登录");
    expect(html).toContain("当前使用自定义大模型 API Key");
    expect(html).toContain("登录 / 注册");
    expect(source).toContain('dispatch(appActions.navigate("/welcome"))');
    expect(source).not.toContain('setConfirm("exitLocal")');
    expect(source).not.toContain("settings.account.exitLocal");
  });

  it("本地自定义模式展示独立连接工作区和能力选择", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createByokModeState()));

    expect(html).toContain("未登录");
    expect(html).toContain("当前使用自定义大模型 API Key");
    expect(html).toContain("登录 / 注册");
    expect(html).toContain("自定义 API Key");
    expect(html).toContain("还没有自定义模型");
    expect(html).toContain("添加配置");
    expect(html).toContain("记忆摘要");
    expect(html).toContain("整理对话 / 历史为记忆");
    expect(html).toContain("技能进化");
    expect(html).toContain("打磨 Agent 技能与偏好");
    expect(html).toContain("Embedding 检索");
    expect(html).toContain("记忆向量化检索");
    expect(html).toContain("Memmy Platform 本地 Embedding");
    expect(html).toContain("语音识别 ASR");
    expect(html).toContain("生图模型");
    expect(html).toContain("未配置");
    expect(html).toContain("Token 用量");
    expect(html).toContain("自定义 API Key 消耗");
    expect(html).not.toContain("查看用量详情");
    expect(html).not.toContain("分别查看平台赠送额度和自定义 API Key 消耗");
    expect(html).not.toContain("切换回平台 Token");
    expect(html).not.toContain("当前模式：");
    expect(html).not.toContain("默认任务模型");
    expect(html).not.toContain("赠送大模型额度已用");
    expect(html).not.toContain("协议类型");
    expect(html).not.toContain("API 地址");
    expect(html).not.toContain('class="text-text-ink/65">API Key</span>');
    expect(html).not.toContain("历史账号");
    expect(html).not.toContain("legacy@example.com");
    expect(html).not.toContain("退出登录");
    expect(html).not.toContain("修改昵称");
    expect(html).not.toContain("注册时间：");
    expect(html).not.toContain("注册于");
  });

  it("模型连接弹窗不展示高级选项和 Token 限额", () => {
    const source = readFileSync(modelWorkspaceSourcePath, "utf8");

    expect(source).not.toContain("showEditorAdvanced");
    expect(source).not.toContain('t("apiKey.advanced")');
    expect(source).not.toContain('t("apiKey.maxTokens")');
    expect(source).not.toContain('t("apiKey.dailyLimit")');
  });

  it("自填 API Key 设置页从完整脱敏配置回填模型概要", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createByokModeWithSavedModelState()));

    expect(html).toContain("main-model");
    expect(html).toContain("memory-model");
    expect(html).toContain("skill-model");
    expect(html).toContain("embedding-model");
    expect(html).toContain("qwen3-asr-flash");
    expect(html).toContain("doubao-seedream-4-0-250828");
    expect(html).not.toContain("未设置");
  });

  it("英文模式下 ASR 和生图模型配置概要使用英文文案", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createByokModeWithSavedModelState(), "en-US"));

    expect(html).toContain("Speech recognition ASR");
    expect(html).toContain("Used for pet and main UI voice input; text features work without it");
    expect(html).toContain("qwen3-asr-flash");
    expect(html).toContain("Image generation model");
    expect(html).toContain("Used for Agent image generation; text features work without it");
    expect(html).toContain("doubao-seedream-4-0-250828");
    expect(html).not.toContain("语音识别 ASR");
  });

  it("catalog 读取或保存失败时在模型工作区展示错误", () => {
    const source = readFileSync(modelWorkspaceSourcePath, "utf8");

    expect(source).toContain("modelWorkspaceErrorText(error, t)");
    expect(source).not.toContain("MessageToast");
    expect(source).toContain('role="alert"');
    expect(source).toContain("{saveError}");
    expect(source).toContain("mutationErrorText(result.error, t)");
    expect(source.indexOf("{saveError}")).toBeLessThan(source.indexOf('t("settings.modelWorkspace.bindingTitle")'));
  });

  it("模型工作区用同步 busy gate 阻止快速连续 PUT，且迟到的初始 GET 不覆盖本地 mutation", () => {
    const source = readFileSync(modelWorkspaceSourcePath, "utf8");

    expect(source).toContain("if (saveInFlightRef.current) return false;");
    expect(source).toContain("saveInFlightRef.current = true;");
    expect(source).toContain("saveInFlightRef.current = false;");
    expect(source).toContain("hasMutatedRef.current = true;");
    expect(source).toContain("if (!active || hasMutatedRef.current) return;");
    expect(source).toContain("setWorkspace(createModelWorkspace(saved));");
  });

  it("模型工作区连接编辑展示已保存脱敏 key，且保存不回传脱敏值", () => {
    const workspaceSource = readFileSync(fileURLToPath(new URL("../model-workspace-section.tsx", import.meta.url)), "utf8");
    const fieldsSource = readFileSync(fileURLToPath(new URL("../api-key-form-fields.tsx", import.meta.url)), "utf8");

    expect(workspaceSource).toContain("maskedValue={editor.connectionId && !editorProviderChanged");
    expect(workspaceSource).toContain("apiKey: editor.apiKey || undefined");
    expect(workspaceSource).toContain("apiKeyMasked:");
    expect(fieldsSource).toContain("const placeholder = !props.value.trim() && props.maskedValue ? props.maskedValue : props.placeholder;");
    expect(fieldsSource).toContain("placeholder={placeholder}");
    expect(fieldsSource).not.toContain("const showSavedSecret = !props.value.trim() && Boolean(props.maskedValue)");
  });
  it("设置页已移除旧内联模型保存链路，模型工作区只走 catalog API", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(source).not.toContain("function persistApiConfig(");
    expect(source).not.toContain("function handleSaveApiConfig(");
    expect(source).not.toContain("saveModelConfig(");
    expect(source).toContain("<ModelWorkspaceSection");
  });

  it("注册账号账户区使用首字母缩写头像，并把修改昵称和退出登录接到真实账号行为", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createAccountModeState()));
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(html).toContain(">G</span>");
    expect(html).toContain("aria-label=\"修改昵称\"");
    expect(html).toContain("退出登录");
    expect(source).toContain("accountClient?.updateProfile");
    expect(source).toContain("accountClient?.logout");
    expect(source).toContain("appActions.accountCleared()");
  });

  it("退出登录后刷新 canonical 配置，并按实际 BYOK Agent 模型决定落点", async () => {
    const catalogWithUnselectedByokAgent = createCatalog(true);
    catalogWithUnselectedByokAgent.modelAssignments.byok.agent = { candidates: [], default: null };
    expect(hasConfiguredByokAgentModel(catalogWithUnselectedByokAgent)).toBe(true);
    expect(hasConfiguredByokAgentModel(createCatalog(false))).toBe(false);

    const dispatch = vi.fn();
    const canonicalModelConfig = {
      ...createAccountModeWithSavedModelState().modelConfig,
      catalog: catalogWithUnselectedByokAgent
    };
    const configClient = {
      getModelConfig: vi.fn(async () => canonicalModelConfig),
      updateSettings: vi.fn(async (settings) => settings)
    };

    await expect(finalizeAccountLogout({
      modelConfig: createAccountModeState().modelConfig,
      configClient,
      dispatch
    })).resolves.toBe("byok");

    expect(configClient.getModelConfig).toHaveBeenCalledOnce();
    expect(configClient.updateSettings).toHaveBeenCalledWith({ userMode: "byok" });
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      "modelConfig/updated",
      "account/cleared",
      "settings/updated",
      "settings/updated"
    ]);
  });

  it("退出后的 canonical 刷新失败时仅使用缓存 BYOK catalog 回退", async () => {
    const dispatch = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const configClient = {
      getModelConfig: vi.fn(async () => { throw new Error("model config offline"); }),
      updateSettings: vi.fn(async (settings) => settings)
    };

    try {
      await expect(finalizeAccountLogout({
        modelConfig: createAccountModeWithSavedModelState().modelConfig,
        configClient,
        dispatch
      })).resolves.toBe("byok");
    } finally {
      warn.mockRestore();
    }

    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      "account/cleared",
      "settings/updated",
      "settings/updated"
    ]);
  });

  it("退出后的模式保存失败不回滚已清除账号，并继续返回欢迎页落点", async () => {
    const dispatch = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const canonicalModelConfig = createAccountModeState().modelConfig;
    const configClient = {
      getModelConfig: vi.fn(async () => canonicalModelConfig),
      updateSettings: vi.fn(async () => { throw new Error("settings offline"); })
    };

    try {
      await expect(finalizeAccountLogout({
        modelConfig: createAccountModeWithSavedModelState().modelConfig,
        configClient,
        dispatch
      })).resolves.toBe("unset");
    } finally {
      warn.mockRestore();
    }

    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      "modelConfig/updated",
      "account/cleared",
      "settings/updated"
    ]);
    const source = readFileSync(settingsPageSourcePath, "utf8");
    expect(source).toContain('if (nextUserMode === "unset")');
    expect(source).toContain('dispatch(appActions.navigate("/welcome"))');
  });

  it("中文输入法组合输入中的 Enter 只确认候选，不保存账户昵称", () => {
    expect(shouldSaveAccountNicknameOnKeyDown(nicknameKeyEvent({ nativeEvent: { isComposing: true } }))).toBe(false);
    expect(shouldSaveAccountNicknameOnKeyDown(nicknameKeyEvent({ nativeEvent: { keyCode: 229 } }))).toBe(false);
    expect(shouldSaveAccountNicknameOnKeyDown(nicknameKeyEvent({ nativeEvent: { isComposing: false, keyCode: 13 } }))).toBe(true);
    expect(shouldSaveAccountNicknameOnKeyDown(nicknameKeyEvent({ key: "Escape" }))).toBe(false);

    const source = readFileSync(settingsPageSourcePath, "utf8");
    expect(source).toContain("if (shouldSaveAccountNicknameOnKeyDown(event))");
  });

  it("设置页账户区长昵称和账号按真实溢出再显示提示", () => {
    const longAccountState = appReducer(
      createAccountModeState(),
      appActions.accountUpdated({
        nickname: "悠然麦穗春日记忆助手版",
        email: "grace@superlongcompanydomain.example.com",
        phoneNumber: null,
        registeredAt: "2026-04-12T00:00:00.000Z"
      })
    );
    const html = normalizeSsrHtml(renderSettingsPageView(longAccountState));
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(html).toContain("settings-account-summary");
    expect(html).toContain("悠然麦穗春日记忆助手版");
    expect(html).toContain("g***@superlongcompanydomain.example.com");
    expect(html).not.toContain("悠然麦穗春日记忆助手…");
    expect(html).not.toContain("g***@superlongcompanydom…");
    expect(source).toContain("OverflowTooltipText");
    const overflowSource = readFileSync(overflowTooltipSourcePath, "utf8");
    expect(overflowSource).toContain("function OverflowTooltipText");
    expect(overflowSource).toContain("element.scrollWidth > element.clientWidth + 1");
    expect(source).not.toContain("SETTINGS_ACCOUNT_NAME_MAX_VISUAL_WIDTH");
  });
});

describe("赠送活动开关 - Token 页申请更多按钮", () => {
  const LOW_HINT = "赠送 Token 余量偏低";
  const APPLY_MORE = "申请更多";

  it("promotions.applyMore 开启且余量偏低时同时展示提示文案和申请更多按钮", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createLowTokenState(true)));

    expect(html).toContain(LOW_HINT);
    expect(html).toContain(APPLY_MORE);
  });

  it("promotions.applyMore 关闭时隐藏申请更多按钮，但余量偏低提示文案仍常显", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createLowTokenState(false)));

    // Key regression point: only hide the button, not the hint text.
    expect(html).toContain(LOW_HINT);
    expect(html).not.toContain(APPLY_MORE);
  });

  it("申请中状态只在窗口重新聚焦时刷新，不启动定时轮询", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(source).toContain("tokenQuotaClient.getEligibility()");
    expect(source).toContain('t("settings.token.applyMore.pending")');
    expect(source).toContain('t("settings.token.applyMore.pendingDesc")');
    expect(source).toContain("const quotaApplicationBlocked = quotaEligibility !== null && quotaEligibility.state !== \"available\"");
    expect(source).toContain("if (quotaApplicationBlocked || !canSubmitFeedback(feedbackText) || feedbackSubmitting)");
    expect(source).toContain('window.addEventListener("focus"');
    expect(source).not.toContain("window.setInterval");
    expect(source).toContain("dispatch(appActions.tokenUsageUpdated(nextTokenUsage));");
  });

  it("冷却期拒绝且没有理由时展示固定兜底文案和下次可申请时间", () => {
    const message = resolveQuotaEligibilityMessage({
      state: "cooldown",
      requestCount: 1,
      maxRequestCount: 5,
      nextAllowedAtEpochMs: new Date(2026, 6, 29, 15, 0).getTime(),
      latestRequestStatus: "rejected",
      latestReviewNote: null
    }, "zh-CN");

    expect(message).not.toBeNull();
    expect(formatMessage(zhCNMessages[message!.key], message!.values)).toBe(
      "申请未通过。7 月 29 日 15:00 后可再次申请。"
    );
  });

  it("达到 5 次上限时展示最近拒绝理由且不再给出申请入口", () => {
    const message = resolveQuotaEligibilityMessage({
      state: "limit_reached",
      requestCount: 5,
      maxRequestCount: 5,
      nextAllowedAtEpochMs: null,
      latestRequestStatus: "rejected",
      latestReviewNote: "申请场景说明不够具体"
    }, "zh-CN");

    expect(message).toEqual({
      key: "settings.token.applyMore.limitRejectedWithReason",
      values: { reason: "申请场景说明不够具体", count: 5 }
    });
  });

  it("重复 pending 申请错误会转成申请中状态", () => {
    expect(isPendingQuotaRequestError(Object.assign(new Error("已有待审批的额度申请，请勿重复提交"), { code: "conflict" }))).toBe(true);
    expect(isPendingQuotaRequestError(new Error("request already pending"))).toBe(true);
    expect(isPendingQuotaRequestError(new Error("network failed"))).toBe(false);
  });
});

/**
 * Creates a low-balance (>=80% used) registered-account settings page state, toggling the "apply for more" button as needed.
 *
 * @param applyMore The promotions.applyMore toggle value.
 * @returns A low-balance, account-mode settings page state.
 */
function createLowTokenState(applyMore: boolean): AppState {
  const lowBootstrap = {
    ...mockBootstrap,
    tokenUsage: {
      ...mockBootstrap.tokenUsage,
      usedTokens: 27_000_000,
      remainingTokens: 3_000_000
    },
    promotions: {
      loginBanner: true,
      improvementGift: true,
      improvementGiftRewardTokens: 1_000_000,
      applyMore,
      agentChatTokenTotal: mockBootstrap.promotions?.agentChatTokenTotal ?? 0
    }
  };
  const bootstrapped = appReducer(createInitialAppState(), appActions.bootstrapLoaded(lowBootstrap, "/settings"));
  const accountReady = appReducer(
    bootstrapped,
    appActions.accountUpdated({
      nickname: "",
      email: "grace@example.com",
      phoneNumber: null,
      registeredAt: "2026-04-12T00:00:00.000Z"
    })
  );
  return appReducer(accountReady, appActions.settingsUpdated({ defaultLaunchMode: "pet", language: "zh-CN", userMode: "account" }));
}

/**
 * Renders the settings page as a pure view.
 *
 * @param state The global state to render.
 * @returns The SSR HTML string.
 */
function renderSettingsPageView(
  state: AppState,
  language: "zh-CN" | "en-US" = "zh-CN",
  update = createUpdateViewModel(),
  platform?: string
): string {
  return renderToString(
    <I18nProvider language={language}>
      <SettingsPageView state={state} dispatch={vi.fn()} update={update} platform={platform} />
    </I18nProvider>
  );
}

function createUpdateViewModel(
  overrides: Partial<UpdateCoordinatorValue> = {}
): UpdateCoordinatorValue {
  return {
    appVersion: "2.1.0",
    phase: "idle",
    preparedUpdatePath: null,
    downloadProgress: null,
    feedback: null,
    requestInlineAction: vi.fn(async () => undefined),
    requestPrimaryAction: vi.fn(async () => undefined),
    ...overrides
  };
}

/**
 * Normalizes React SSR comment delimiters.
 *
 * @param html The HTML output by SSR.
 * @returns The HTML with React text-boundary comments stripped.
 */
function normalizeSsrHtml(html: string): string {
  return html.replaceAll("<!-- -->", "");
}

function nicknameKeyEvent(
  overrides: { key?: string; nativeEvent?: { isComposing?: boolean; keyCode?: number } } = {}
) {
  return {
    key: overrides.key ?? "Enter",
    nativeEvent: overrides.nativeEvent ?? { isComposing: false, keyCode: 13 }
  } as any;
}

/**
 * Creates a settings page state with an account and bootstrap.
 *
 * @returns The frontend state after startup, on the settings page.
 */
function createReadyState(): AppState {
  return createAccountModeState();
}

/**
 * Creates a settings page state in registered-account login mode.
 *
 * @returns An account-mode settings page state.
 */
function createAccountModeState(): AppState {
  const accountBootstrap = {
    ...mockBootstrap,
    tokenUsage: {
      ...mockBootstrap.tokenUsage,
      usedTokens: 18_420_000,
      remainingTokens: 11_580_000,
      sceneUsages: [
        {
          scene: "agent_chat" as const,
          totalTokens: 5_000_000,
          usedTokens: 1_420_000,
          remainingTokens: 3_580_000
        },
        {
          scene: "memory_summary" as const,
          totalTokens: 20_000_000,
          usedTokens: 15_000_000,
          remainingTokens: 5_000_000
        },
        {
          scene: "memory_evolution" as const,
          totalTokens: 5_000_000,
          usedTokens: 2_000_000,
          remainingTokens: 3_000_000
        }
      ]
    }
  };
  const bootstrapped = appReducer(createInitialAppState(), appActions.bootstrapLoaded(accountBootstrap, "/settings"));
  const accountReady = appReducer(
    bootstrapped,
    appActions.accountUpdated({
      nickname: "",
      email: "grace@example.com",
      phoneNumber: null,
      registeredAt: "2026-04-12T00:00:00.000Z"
    })
  );
  const preferredModeReady = appReducer(accountReady, appActions.preferredModeUpdated("pet"));
  const settingsReady = appReducer(preferredModeReady, appActions.settingsUpdated({ defaultLaunchMode: "pet", language: "zh-CN", userMode: "account" }));

  return appReducer(settingsReady, appActions.modelConfigUpdated({ catalog: createCatalog(false) }));
}

/**
 * Creates a settings page state in phone-number registered-account login mode.
 *
 * @returns A phone-number account-mode settings page state.
 */
function createPhoneAccountModeState(): AppState {
  const accountState = createAccountModeState();

  return appReducer(
    accountState,
    appActions.accountUpdated({
      nickname: "喜乐松鼠",
      email: "",
      phoneNumber: "13800138000",
      registeredAt: "2026-06-09T00:00:00.000Z"
    })
  );
}

/**
 * Creates an account-mode settings page state missing both email and phone number.
 *
 * @returns A settings page state with no account identifier.
 */
function createAccountModeWithoutIdentifierState(): AppState {
  const accountState = createAccountModeState();

  return appReducer(
    accountState,
    appActions.accountUpdated({
      nickname: "喜乐松鼠",
      email: "",
      phoneNumber: null,
      registeredAt: "2026-06-09T00:00:00.000Z"
    })
  );
}

/**
 * Creates an account-mode settings page state that includes an international
 * email account's 300,000 Token improvement-program reward.
 *
 * @returns A settings page state with a total of 30,300,000 Tokens.
 */
function createImprovementBonusState(): AppState {
  const state = createAccountModeState();

  return appReducer(
    state,
    appActions.tokenUsageUpdated({
      planName: "free",
      totalTokens: 30_300_000,
      usedTokens: 0,
      remainingTokens: 30_300_000,
      expiresAt: null,
      lastSyncedAt: "2026-06-09T06:36:49.417Z",
      sceneUsages: []
    })
  );
}

/**
 * Creates a settings page state where a local model config has already been saved under a registered account.
 *
 * @returns A settings page state that has a model config but is still in registered-account mode.
 */
function createAccountModeWithSavedModelState(): AppState {
  const accountState = createAccountModeState();

  return appReducer(
    accountState,
    appActions.modelConfigUpdated({
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: "",
      apiKeyMasked: "sk••••test",
      configured: true,
      catalog: createCatalog(true)
    })
  );
}

/**
 * Creates a bring-your-own API Key mode settings page state.
 *
 * @returns A local API Key mode settings page state.
 */
function createByokModeState(): AppState {
  const bootstrapped = appReducer(createInitialAppState(), appActions.bootstrapLoaded(mockBootstrap, "/settings"));
  const staleAccountReady = appReducer(
    bootstrapped,
    appActions.accountUpdated({
      nickname: "历史账号",
      email: "legacy@example.com",
      phoneNumber: null,
      registeredAt: "2026-06-02T10:00:00.000Z"
    })
  );
  const settingsReady = appReducer(staleAccountReady, appActions.settingsUpdated({ defaultLaunchMode: "pet", userMode: "byok" }));

  return settingsReady;
}

function createByokModeWithSavedModelState(): AppState {
  return appReducer(
    createByokModeState(),
    appActions.modelConfigUpdated({
      provider: "openai",
      endpoint: "https://main.example.com/v1",
      model: "main-model",
      apiKey: "",
      apiKeyMasked: "sk-m••••main",
      configured: true,
      embedding: {
        mode: "custom",
        endpoint: "https://embedding.example.com/v1",
        model: "embedding-model",
        apiKey: "",
        apiKeyMasked: "sk-e••••ding",
        configured: true
      },
      memmyMemory: {
        summary: {
          provider: "anthropic",
          endpoint: "https://memory.example.com/v1",
          model: "memory-model",
          apiKey: "",
          apiKeyMasked: "sk-m••••mory",
          configured: true
        },
        evolution: {
          provider: "qwen",
          endpoint: "https://skill.example.com/v1",
          model: "skill-model",
          apiKey: "",
          apiKeyMasked: "sk-s••••kill",
          configured: true
        }
      },
      asr: {
        provider: "aliyun",
        endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3-asr-flash",
        apiKey: "",
        apiKeyMasked: "sk-a••••asr",
        configured: true
      },
      imageGen: {
        provider: "doubao",
        endpoint: "https://ark.cn-beijing.volces.com/api/v3",
        model: "doubao-seedream-4-0-250828",
        apiKey: "",
        apiKeyMasked: "sk-i••••mage",
        configured: true
      },
      catalog: createCatalog(true)
    })
  );
}

function createCatalog(includeByok: boolean): ModelConfigView {
  const accountAgent = {
    presetId: "account-agent",
    provider: "memmy_account" as const,
    endpointId: "account",
    protocol: "memmy-account" as const,
    model: "agent_chat",
    source: "account" as const,
    ownerAccountId: "owner-a",
    capabilities: ["agent" as const],
    available: true
  };
  const accountAsr = {
    ...accountAgent,
    presetId: "account-asr",
    model: "asr",
    capabilities: ["asr" as const]
  };
  const byokPresets = [
    ["main", "main-model", "agent", "chat", "openai-chat-completions", "https://main.example.com/v1"],
    ["memory", "memory-model", "memory_summary", "memory", "anthropic-messages", "https://memory.example.com/v1"],
    ["skill", "skill-model", "memory_evolution", "skill", "openai-chat-completions", "https://skill.example.com/v1"],
    ["embedding", "embedding-model", "embedding", "embedding", "openai-embeddings", "https://embedding.example.com/v1"],
    ["asr", "qwen3-asr-flash", "asr", "asr", "dashscope-input-audio-chat", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
    ["image", "doubao-seedream-4-0-250828", "image_generation", "image", "openai-images", "https://ark.cn-beijing.volces.com/api/v3"]
  ].map(([id, model, capability, endpointId, protocol]) => ({
    presetId: `byok-${id}`,
    provider: "openai" as const,
    endpointId: endpointId!,
    protocol: protocol as any,
    model: model!,
    source: "byok" as const,
    capabilities: [capability as any],
    available: true
  }));
  const accountProvider = {
    provider: "memmy_account" as const,
    configured: true,
    hasApiKey: false,
    apiKeyMasked: "",
    apiKey: "",
    ownerAccountId: "owner-a",
    endpoints: [{ endpointId: "account", apiBase: "https://account.memmy.ai/v1", protocol: "memmy-account" as const, hasApiKey: false, apiKeyMasked: "", apiKey: "" }],
    accountManaged: true,
    editable: false,
    models: [accountAgent, accountAsr]
  };
  const byokProvider = {
    provider: "openai" as const,
    configured: true,
    hasApiKey: false,
    apiKeyMasked: "",
    apiKey: "",
    endpoints: [
      ["chat", "openai-chat-completions", "https://main.example.com/v1"],
      ["memory", "anthropic-messages", "https://memory.example.com/v1"],
      ["skill", "openai-chat-completions", "https://skill.example.com/v1"],
      ["embedding", "openai-embeddings", "https://embedding.example.com/v1"],
      ["asr", "dashscope-input-audio-chat", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
      ["image", "openai-images", "https://ark.cn-beijing.volces.com/api/v3"]
    ].map(([endpointId, protocol, apiBase]) => ({ endpointId: endpointId!, apiBase: apiBase!, protocol: protocol as any, hasApiKey: true, apiKeyMasked: "sk••••test", apiKey: "" })),
    accountManaged: false,
    editable: true,
    models: byokPresets
  };
  const byokAssignment = {
    agent: { candidates: includeByok ? ["byok-main"] : [], default: includeByok ? "byok-main" : null },
    memorySummary: includeByok ? "byok-memory" : null,
    memoryEvolution: includeByok ? "byok-skill" : null,
    embedding: includeByok ? "byok-embedding" : null,
    asr: includeByok ? "byok-asr" : null,
    imageGeneration: includeByok ? "byok-image" : null
  };
  return {
    configRevision: "revision-settings",
    providers: includeByok ? [accountProvider, byokProvider] : [accountProvider],
    modelAssignments: {
      byok: byokAssignment,
      account: {
        ownerAccountId: "owner-a",
        agent: { candidates: includeByok ? ["account-agent", "byok-main"] : ["account-agent"], default: "account-agent" },
        memorySummary: "account-agent",
        memoryEvolution: "account-agent",
        embedding: includeByok ? "byok-embedding" : null,
        asr: "account-asr",
        imageGeneration: includeByok ? "byok-image" : null
      }
    },
    effectiveCandidates: {
      byok: includeByok ? byokPresets : [],
      account: includeByok ? [accountAgent, accountAsr, ...byokPresets] : [accountAgent, accountAsr]
    },
    configured: true,
    updatedAt: "2026-08-11T00:00:00.000Z"
  };
}
