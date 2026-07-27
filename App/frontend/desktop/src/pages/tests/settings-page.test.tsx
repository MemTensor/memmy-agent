/** Settings page tests. */
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";
import { appActions } from "../../state/app-actions.js";
import { appReducer, createInitialAppState, type AppState } from "../../state/app-reducer.js";
import type { UpdateCoordinatorValue } from "../../app/update-coordinator.js";
import {
  LOG_LEVEL_STORAGE_KEY,
  SettingsPageView,
  formatUsageUpdatedAt,
  isPendingQuotaRequestError,
  resolveQuotaEligibilityMessage,
  readLogLevel,
  shouldSaveAccountNicknameOnKeyDown,
  writeLogLevel
} from "../settings-page.js";
import { formatMessage, zhCNMessages } from "../../i18n/messages.js";

const settingsPageSourcePath = fileURLToPath(new URL("../settings-page.tsx", import.meta.url));
const updateCoordinatorSourcePath = fileURLToPath(new URL("../../app/update-coordinator.tsx", import.meta.url));
const browserUpdateSourcePath = fileURLToPath(new URL("../../app/browser-update.ts", import.meta.url));
const tokenUsageStylesPath = fileURLToPath(new URL("../settings-token-usage.module.css", import.meta.url));
const modelConfigSourcePath = fileURLToPath(new URL("../model-config.ts", import.meta.url));
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

describe("SettingsPageView", () => {
  it("对齐 Memmy v2.0 设置页卡片结构和关键内容", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createReadyState()));

    expect(html).toContain("app-frame-page-content max-w-2xl mx-auto py-8");
    expect(html).toContain("bg-background-paper rounded-card-lg border-content-panel p-6");
    expect(html).toContain("账户");
    expect(html).toContain("Token 用量");
    expect(html).toContain("模型配置");
    expect(html).toContain("通用");
    expect(html).toContain("启动与窗口");
    expect(html).toContain("通知");
    expect(html).toContain("隐私");
    expect(html).toContain("高级 / 开发者");
    expect(html).toContain("关于");
    expect(html).toContain("g***@example.com");
    expect(html).toContain("g***@example.com");
    expect(html).toContain("注册时间：2026-04-12");
    expect(html).toContain("赠送大模型额度已用 18.4M Token");
    expect(html).toContain("共 30.0M Token");
    expect(html).toContain("平台赠送大模型");
    expect(html).toContain("自有 API Key");
    expect(html).toContain("查看用量详情");
    expect(html).toContain("select-control--compact select-control--subtle");
    expect(html).toContain('role="combobox"');
  });

  it("按 2026-06-09 原型让模型配置排在 Token 用量之前", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createReadyState()));
    const modelIndex = html.indexOf("模型配置");
    const usageIndex = html.indexOf("Token 用量");

    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(modelIndex).toBeLessThan(usageIndex);
  });

  it("使用原型 SettingsPage 的 lucide 图标而不是字母占位", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createReadyState()));

    expect(html).toContain("lucide-user");
    expect(html).toContain("lucide-zap");
    expect(html).toContain("lucide-brain");
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
    expect(html).toContain("g***@example.com");
    expect(html).toContain("注册时间：2026-04-12");
    expect(html).toContain("桌宠模式");
    expect(html).toContain("中文");
    expect(html).not.toContain("<select");
    expect(html).toContain("已关闭行为数据收集");
    expect(html).toContain("赠送大模型额度已用 18.4M Token");
    expect(html).not.toContain("已使用 0 Token");
    expect(html).not.toContain("System");
    expect(html).not.toContain("注册于");
  });

  it("Token 用量展示参与奖励后的 5,000,000 Token 增量", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createImprovementBonusState()));

    expect(html).toContain("赠送大模型额度已用 0.0M Token");
    expect(html).toContain("共 35.0M Token");
    expect(html).toContain("剩余 35.0M Token");
    expect(html).not.toContain("共 30.0M Token");
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

  it("注册账号模式展示账户、Token 用量和平台赠送模型模式", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createAccountModeState()));
    const modelConfigHtml = html.slice(html.indexOf("模型配置"), html.indexOf("Token 用量"));

    expect(html).toContain("g***@example.com");
    expect(html).toContain("g***@example.com");
    expect(html).toContain("注册时间：2026-04-12");
    expect(html).toContain("修改昵称");
    expect(html).toContain("Token 用量");
    expect(html).toContain("平台赠送 Token");
    expect(html).toContain("赠送 Token 永不过期");
    expect(html).toContain("平台赠送大模型");
    expect(html).toContain("自有 API Key");
    expect(html).toContain("查看用量详情");
    expect(html).not.toContain("协议类型");
    expect(modelConfigHtml).not.toContain("自有 API Key</span>");
  });

  it("平台 Token 模式下模型配置卡不保留空正文间距", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createAccountModeState()));
    const modelConfigStart = html.indexOf("模型配置");
    const tokenUsageStart = html.indexOf("Token 用量");
    const modelConfigHtml = html.slice(modelConfigStart, tokenUsageStart);

    expect(modelConfigHtml).toContain("当前模式：");
    expect(modelConfigHtml).toContain("平台赠送 Token");
    expect(modelConfigHtml).toContain("切换为自有 API Key");
    expect(modelConfigHtml).not.toContain("mb-4");
  });

  it("手机号注册账号区展示手机号，邮箱注册账号区展示邮箱", () => {
    const phoneHtml = normalizeSsrHtml(renderSettingsPageView(createPhoneAccountModeState()));
    const emailHtml = normalizeSsrHtml(renderSettingsPageView(createAccountModeState()));

    expect(phoneHtml).toContain("138****8000");
    expect(phoneHtml).not.toContain("未绑定邮箱");
    expect(emailHtml).toContain("g***@example.com");
  });

  it("注册账号缺少账号标识时不误提示未绑定邮箱", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createAccountModeWithoutIdentifierState()));

    expect(html).toContain("未绑定手机号或邮箱");
    expect(html).not.toContain("未绑定邮箱");
  });

  it("注册账号即使已有本地模型配置也先展示平台 Token 原型态", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createAccountModeWithSavedModelState()));
    const modelConfigHtml = html.slice(html.indexOf("模型配置"), html.indexOf("Token 用量"));

    expect(html).toContain("g***@example.com");
    expect(html).toContain("g***@example.com");
    expect(html).toContain("注册时间：2026-04-12");
    expect(html).toContain("Token 用量");
    expect(html).toContain("平台赠送 Token");
    expect(html).toContain("切换为自有 API Key");
    expect(modelConfigHtml).not.toContain("自有 API Key</span>");
    expect(html).not.toContain("Agent 执行任务");
    expect(html).not.toContain("协议类型");
    expect(html).not.toContain("API 地址");
    expect(html).not.toContain("本地模式");
    expect(html).not.toContain("无需注册账号");
  });

  it("注册账号 Token 切换按钮按三态逻辑处理自有 API Key 表单和模式持久化", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(source).toContain("function handleSwitchToCustom()");
    expect(source).toContain("const hasAccountSession");
    expect(source).toContain("const hasByokConfig");
    expect(source).toContain("setShowApiConfig(true)");
    expect(source).toContain('persistSettings({ userMode: "byok" })');
    expect(source).toContain('persistSettings({ userMode: "account" })');
    expect(source).toContain("createMemmyMemoryProviderConfig");
    expect(source).toContain("configClient?.saveModelConfig(nextConfig)");
    expect(source).toContain('onClick={handleSwitchToCustom}');
    expect(source).toContain("{showApiConfig && (");
    expect(source).toContain('t("settings.model.localEmbeddingModelHint")');
    expect(source).toContain('t("settings.model.saveConfig")');
    expect(source).not.toContain("setForcedModelMode");
    expect(source).not.toContain('navigate("/api-key")');
  });

  it("Token 用量按原型包含渠道汇总和详情子页结构", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");
    const styles = readFileSync(tokenUsageStylesPath, "utf8");

    expect(source).toContain("configClient.getTokenUsage()");
    expect(source).toContain("dispatch(appActions.tokenUsageUpdated(tokenUsage))");
    expect(source).toContain("byokTokenUsageClient.getSummary");
    expect(source).toContain("EMPTY_BYOK_TOKEN_USAGE");
    expect(source).toContain("function ChannelStat");
    expect(source).toContain("function UsageDetailView");
    expect(source).toContain("function UsageKindRow");
    expect(source).toContain("function TokenMetric");
    expect(source).toContain('props.tone === "success" ? formatTokenSummary(props.value) : formatNumber(props.value)');
    expect(source).toContain("function formatTokenSummary");
    expect(source).toContain('return abbreviated === "0.0M" ? formatTokens(value) : abbreviated;');
    expect(source).toContain('import usageStyles from "./settings-token-usage.module.css";');
    expect(source).toContain("usageStyles.detailPage");
    expect(source).toContain('className="app-frame-page-content"');
    expect(source).toContain("usageStyles.overview");
    expect(source).toContain("usageStyles.usageCard");
    expect(source).toContain("usageStyles.shareDial");
    expect(source).toContain('t("settings.token.amount")');
    expect(styles).toContain("width: min(100%, 1080px);");
    const pageRule = styles.match(/\.page\s*\{[^}]*\}/)?.[0] ?? "";
    expect(pageRule).toContain("padding: calc(var(--codex-toolbar-height) + 8px) 0 40px;");
    expect(styles.match(/padding: calc\(var\(--codex-toolbar-height\) \+ 8px\) 0/g)?.length).toBeGreaterThanOrEqual(3);
    expect(styles).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(styles).toContain("width: 40px;");
    expect(styles).toContain("width: 54px;");
    expect(styles).toContain("width: 42px;");
    expect(styles).toContain("grid-template-columns: repeat(3, minmax(0, 1fr));");
    expect(styles).toContain(".backButton");
    const backButtonRule = styles.match(/\.backButton\s*\{[^}]*\}/)?.[0] ?? "";
    expect(backButtonRule).toContain("z-index: 10000");
    expect(backButtonRule).toContain("min-height: 44px;");
    expect(backButtonRule).toContain("margin: 0 0 10px -12px;");
    expect(backButtonRule).toContain("padding: 8px 12px;");
    expect(backButtonRule).toContain("pointer-events: auto");
    expect(backButtonRule).toContain("touch-action: manipulation;");
    expect(backButtonRule).toContain("-webkit-app-region: no-drag");
    expect(styles).toContain("@media (max-width: 420px)");
    expect(styles).toContain("conic-gradient(var(--tone) calc(var(--share) * 1%), #eaf3f1 0)");
    expect(styles).toContain("background: #f8fbfa;");
    expect(source).toContain('aria-label={`${share}%`}');
    expect(source).toContain("const hasByokRows");
    expect(source).toContain('t("settings.token.kind.agentChat")');
    expect(source).toContain('t("settings.token.kind.memorySummary")');
    expect(source).toContain('t("settings.token.kind.memoryEvolution")');
    expect(source).toContain('t("settings.token.kind.embedding")');
    expect(source).toContain("updateShowUsageDetail(true)");
    expect(source).toContain('reserveTopBar={!showUsageDetail}');
    expect(source).toContain('t("settings.token.breakdown")');
    expect(source).toContain('t("settings.token.categoryStats")');
    expect(source).toContain('t("settings.token.breakdownHint")');
    expect(source).toContain('t("settings.token.input")');
    expect(source).toContain('t("settings.token.output")');
    expect(source).toContain('t("settings.token.cacheHit")');
    expect(source).not.toContain("meta.barClass");
  });

  it("模型测试连接按钮固定位置和尺寸，状态提示展示在按钮左侧", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");
    const messageIndex = source.indexOf("<ValidationMessage validation={llmValidation} stale={isMainModelTestStale} />");
    const buttonIndex = source.indexOf("<TestButton status={llmValidation.status} onClick={testMainModelConnection} disabled={false} />");

    expect(source).toContain('className="flex min-h-9 items-center justify-end gap-3"');
    expect(source).toContain("inline-flex w-[112px] h-10 shrink-0 items-center justify-center px-4");
    expect(source).toContain('<span className="inline-flex items-center justify-center gap-1.5">');
    expect(source).toContain('<CheckCircle2 size={13} className="shrink-0" aria-hidden="true" />');
    expect(source).toContain('<XCircle size={13} className="shrink-0" aria-hidden="true" />');
    expect(source).not.toContain("grid-cols-[13px_auto_13px]");
    expect(source).not.toContain("absolute left-3 top-1/2 -translate-y-1/2");
    expect(source).not.toContain("function simulateTest");
    expect(source).toContain("testModelConfigConnection");
    expect(source).toContain("testEmbeddingConnection");
    expect(source).toContain('"embedding"');
    expect(source).toContain("canUseModelConfig");
    expect(source).toContain("canSaveEmbeddingModelConfig");
    expect(messageIndex).toBeGreaterThanOrEqual(0);
    expect(buttonIndex).toBeGreaterThanOrEqual(0);
    expect(messageIndex).toBeLessThan(buttonIndex);
  });

  it("协议类型切换同步默认 API 地址，并清空模型 ID 和 API Key", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");
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

    expect(source).toContain("setEndpoint(DEFAULT_ENDPOINTS[nextProtocol])");
    expect(source).toContain('setModelId("")');
    expect(source).toContain('setApiKey("");');
    expect(source).toContain('setApiKeyMasked("");');
    expect(source).toContain("props.onPatch(createModelProtocolPatch(value))");
    expect(modelSource).toContain("endpoint: DEFAULT_ENDPOINTS[protocol]");
    expect(modelSource).toContain('modelId: ""');
    expect(modelSource).toContain('apiKey: ""');
    expect(source).toContain("hydrateModelConfigForm(state.modelConfig");
    expect(source).toContain("useState(initialModelForm.modelId)");
    expect(source).toContain('placeholder={`${t("apiKey.examplePrefix")} ${DEFAULT_MODEL_IDS[protocol]}`}');
    expect(source).toContain('placeholder={`${t("apiKey.examplePrefix")} ${DEFAULT_MODEL_IDS[props.cfg.protocol]}`}');
    expect(source).not.toContain("DEFAULT_MODEL_PLACEHOLDER");
    expect(source).not.toContain('placeholder="例如 qwen2.5-32b-instruct"');
  });

  it("未注册用户退出本地模式前弹出二次确认", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(source).toContain('setConfirm("exitLocal")');
    expect(source).toContain('import { ConfirmDialog } from "../components/confirm-dialog.js";');
    expect(source).toContain("<ConfirmDialog");
    expect(source).toContain('cancelLabel={t("dialog.cancel")}');
    expect(source).toContain('t("settings.account.exitLocalTitle")');
    expect(source).toContain('t("settings.account.exitLocalOk")');
    expect(source).toContain('t("settings.account.exitLocalDesc")');
    expect(source).not.toContain("function ConfirmModal");
  });

  it("自填 API Key 模式仍展示 Token 用量并展示模型配置概要", () => {
    const html = normalizeSsrHtml(renderSettingsPageView(createByokModeState()));

    expect(html).toContain("本地模式");
    expect(html).toContain("无需注册账号 · 使用你自己的大模型 API Key");
    expect(html).toContain("退出");
    expect(html).toContain("自有 API Key");
    expect(html).toContain("修改配置");
    expect(html).toContain("space-y-2 p-3 bg-canvas-oat/40 rounded-card");
    expect(html).toContain("Agent 执行任务");
    expect(html).toContain("主大模型");
    expect(html).toContain("记忆摘要");
    expect(html).toContain("整理对话 / 历史为记忆");
    expect(html).toContain("技能进化");
    expect(html).toContain("打磨 Agent 技能与偏好");
    expect(html).toContain("Embedding 检索");
    expect(html).toContain("记忆向量化检索");
    expect(html).toContain("内嵌本地模型 - Xenova/all-MiniLM-L6-v2");
    expect(html).toContain("语音识别 ASR");
    expect(html).toContain("桌宠和主界面语音输入（可选，不配置不影响其他功能）");
    expect(html).toContain("qwen3-asr-flash");
    expect(html).toContain("生图模型");
    expect(html).toContain("用于 Agent 生成图片");
    expect(html).toContain("未设置");
    expect(html).toContain("Token 用量");
    expect(html).toContain("自有 API Key");
    expect(html).toContain("查看用量详情");
    expect(html).not.toContain("切换回平台 Token");
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
    expect(html).toContain("Pet and main UI voice input");
    expect(html).toContain("qwen3-asr-flash");
    expect(html).toContain("Image generation model");
    expect(html).toContain("Used for Agent image generation");
    expect(html).toContain("doubao-seedream-4-0-250828");
    expect(html).not.toContain("语音识别 ASR");
  });

  it("测试连接成功后的自动保存失败时向用户展示错误而不是只打 warn 日志", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");
    const persistSource = source.slice(
      source.indexOf("function persistSuccessfulMainModelConnection"),
      source.indexOf("function testModelConfigConnection")
    );

    expect(persistSource).toContain('setLlmValidation({');
    expect(persistSource).toContain('message: t("apiKey.testSaveFailed")');
    expect(persistSource).toContain('status: "error"');
  });

  it("设置页模型配置表单展示已保存脱敏 key 状态且保存不回传脱敏值", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    expect(source).toContain("maskedValue={apiKeyMasked}");
    expect(source).toContain("maskedValue={embApiKeyMasked}");
    expect(source).toContain("maskedValue={asrApiKeyMasked}");
    expect(source).toContain("maskedValue={imageGenApiKeyMasked}");
    expect(source).toContain("maskedValue={props.cfg.apiKeyMasked}");
    expect(source).not.toContain('savedLabel={t("apiKey.savedKey")}');
    expect(source).not.toContain("const showSavedSecret = !props.value.trim() && Boolean(props.maskedValue)");
    expect(source).not.toContain('{props.savedLabel ?? "Saved"}');
    expect(source).toContain("const placeholder = !props.value.trim() && props.maskedValue ? props.maskedValue : props.placeholder;");
    expect(source).toContain("placeholder={placeholder}");
    expect(source).toContain('apiKeyMasked: apiKey.trim() ? "" : apiKeyMasked');
    expect(source).toContain('apiKeyMasked: embApiKey.trim() ? "" : embApiKeyMasked');
    expect(source).toContain("createImageGenProviderConfig(imageGenProtocol, imageGenModel, imageGenEndpoint, imageGenApiKey, imageGenApiKeyMasked)");
    expect(source).toContain("persistSuccessfulMainModelConnection");
    expect(source).toContain("preserveSuccessfulTestHydrateRef");
    expect(source).toContain("configClient?.saveModelConfig(successConfig)");
    expect(source).toContain("asr: isAsrUsable ? createAsrProviderConfig(");
    expect(source).toContain('<Mic size={16} className="text-action-sky" />');
    expect(source).toContain("createAsrModelFormValues");
    expect(source).toContain("const [asrValidation, setAsrValidation]");
    expect(source).toContain("const asrFormValues = createAsrModelFormValues(");
    expect(source).toContain("model={asrModelId || ASR_MODEL_ID}");
    expect(source).toContain("value={asrModelId || ASR_MODEL_ID}");
    expect(source).toContain("function testAsrConnection()");
    expect(source).toContain('capability: "asr"');
    expect(source).toContain("<ValidationMessage validation={asrValidation} stale={isAsrTestStale} />");
    expect(source).toContain("<TestButton status={asrValidation.status} onClick={testAsrConnection} disabled={false} />");
    expect(source).toContain("optionalModelMissingWarning");
    expect(source).toContain("<OptionalModelMissingWarningModal");
    expect(source).toContain("setAsrWarningAcknowledged(true)");
    expect(source).toContain("const isAsrUsable = canSaveModelConfig(asrFormValues, asrValidation)");
    expect(source).toContain("resolveOptionalModelMissingWarning({");
    expect(source).toContain("asrMissing: !isAsrUsable && !asrWarningAcknowledged");
    expect(source).toContain("asr: isAsrUsable");
    expect(source).not.toContain("showAsrMissingWarning");
    expect(source).not.toContain("<AsrMissingWarningModal");
    expect(source).toContain('<ImageIcon size={16} className="text-action-sky" />');
    expect(source).toContain("IMAGE_PROTOCOL_OPTIONS.map");
    expect(source).toContain("createImageGenModelFormValues");
    expect(source).toContain("const [imageGenValidation, setImageGenValidation]");
    expect(source).toContain("const imageGenFormValues = createImageGenModelFormValues(");
    expect(source).toContain("function testImageGenConnection()");
    expect(source).toContain('capability: "image"');
    expect(source).toContain("placeholder={IMAGE_DEFAULT_MODEL_IDS[imageGenProtocol]}");
    expect(source).toContain("placeholder={IMAGE_DEFAULT_ENDPOINTS[imageGenProtocol]}");
    expect(source).toContain("<ValidationMessage validation={imageGenValidation} stale={isImageGenTestStale} />");
    expect(source).toContain("<TestButton status={imageGenValidation.status} onClick={testImageGenConnection} disabled={false} />");
    expect(source).toContain("setImageGenWarningAcknowledged(true)");
    expect(source).toContain("const isImageGenUsable = canSaveModelConfig(imageGenFormValues, imageGenValidation)");
    expect(source).toContain("imageGenMissing: !isImageGenUsable && !imageGenWarningAcknowledged");
    expect(source).not.toContain("showImageGenMissingWarning");
    expect(source).not.toContain("<ImageGenMissingWarningModal");
    expect(source).toContain("imageGen: isImageGenUsable");
    expect(source).not.toContain("&& (!isAsrConfigured || canSaveModelConfig(asrFormValues, asrValidation))");
  });

  it("可选模型未填告知弹窗确认后自动继续保存已填的 API 配置", () => {
    const source = readFileSync(settingsPageSourcePath, "utf8");

    const closeFnStart = source.indexOf("function closeOptionalModelMissingWarning()");
    expect(closeFnStart).toBeGreaterThan(-1);
    const closeFnBody = source.slice(closeFnStart, source.indexOf("\n  /**", closeFnStart));

    expect(closeFnBody).toContain("setAsrWarningAcknowledged(true)");
    expect(closeFnBody).toContain("setImageGenWarningAcknowledged(true)");
    expect(closeFnBody).toContain("setOptionalModelMissingWarning(null)");
    expect(closeFnBody).toContain("persistApiConfig(");

    const saveFnStart = source.indexOf("function handleSaveApiConfig()");
    expect(saveFnStart).toBeGreaterThan(-1);
    const saveFnBody = source.slice(saveFnStart, source.indexOf("\n  /**", saveFnStart));

    expect(saveFnBody).toContain("resolveOptionalModelMissingWarning({");
    expect(saveFnBody).toContain("persistApiConfig(");
    expect(saveFnBody).not.toContain("saveModelConfig");
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
      applyMore
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
  update = createUpdateViewModel()
): string {
  return renderToString(
    <I18nProvider language={language}>
      <SettingsPageView state={state} dispatch={vi.fn()} update={update} />
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
      remainingTokens: 11_580_000
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

  return settingsReady;
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
 * Creates an account-mode settings page state that includes a 5,000,000 Token participation-reward increment.
 *
 * @returns A settings page state with a total of 35,000,000 Tokens.
 */
function createImprovementBonusState(): AppState {
  const state = createAccountModeState();

  return appReducer(
    state,
    appActions.tokenUsageUpdated({
      planName: "free",
      totalTokens: 35_000_000,
      usedTokens: 0,
      remainingTokens: 35_000_000,
      expiresAt: null,
      lastSyncedAt: "2026-06-09T06:36:49.417Z"
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
      configured: true
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
      }
    })
  );
}
