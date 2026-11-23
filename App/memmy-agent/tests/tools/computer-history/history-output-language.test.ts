import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerHistoryDemoService } from "../../../src/tools/computer-history/mac/computer-history-api.js";
import { HistoryMemoryAdapter } from "../../../src/tools/computer-history/memory-adapter.js";
import { instantId } from "../../../src/tools/computer-history/mac/rollup.js";

type Runtime = NonNullable<Parameters<ComputerHistoryDemoService["setLlmRuntime"]>[0]>;
type ChatRequest = { messages: Array<{ role: string; content: string }>; maxTokens: number };
let root: string;
const services: ComputerHistoryDemoService[] = [];
const configPath = () => path.join(root, "config.yaml");
const configureLanguage = (language: string) => fs.writeFileSync(configPath(), `memmyMemory:\n  language: ${language}\n`);
const response = (title: string) => ({ content: JSON.stringify({ title, description: title, body: `## Memory summary\n\n${title}\n\n## Recording summary\n\n${title}` }) });
const runtime = (chat: (request: ChatRequest) => Promise<{ content: string }>): Runtime =>
  (() => ({ model: "stub", provider: { chatWithRetry: chat } })) as unknown as Runtime;

function serviceAt(chat: (request: ChatRequest) => Promise<{ content: string }>) {
  const service = new ComputerHistoryDemoService({
    historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "settings.json"),
    weChatConsentFile: path.join(root, "wechat", "consent.json"),
  });
  services.push(service);
  const internal = service as unknown as {
    llmRuntime: Runtime;
    writeSummaryWith(file: string, window: "10min" | "6h", events: string | null): Promise<boolean>;
  };
  internal.llmRuntime = runtime(chat);
  return { service, internal };
}

function seed(window: "10min" | "6h", ready = false) {
  const id = `${instantId(new Date(2026, 8, 11, 6, window === "10min" ? 10 : 0))}-${window}-summary`;
  const file = path.join(root, "histories", `${id}.md`);
  const markdown = `---\ntitle: Original English title\nsource_type: ${window === "10min" ? "captured" : "rollup"}\nsummary_state: ${ready ? "ready" : "pending"}\nstatus: completed\nsummary_window: ${window}\napplications: ["Chrome"]\n---\n\n## Memory summary\n\nVisible deployment review.\n\n## Citations\n\n- original-source\n`;
  fs.writeFileSync(file, markdown);
  return { file, markdown };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "history-output-language-"));
  fs.mkdirSync(path.join(root, "histories"));
  vi.stubEnv("MEMMY_CONFIG", configPath());
  vi.spyOn(HistoryMemoryAdapter.prototype, "schedule").mockImplementation(() => {});
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("App language in the common macOS and Windows History narrator", () => {
  it.each(["darwin", "win32"] as const)("reads App config and generates both summary layers directly on %s", async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    for (const [language, title] of [
      ["zh-CN", "检查部署版本"], ["en-US", "Deployment review"],
      ["ja-JP", "デプロイを確認"], ["fr-FR", "Vérification du déploiement"],
      ["zh-Hant", "檢查部署版本"],
    ]) {
      configureLanguage(language);
      for (const window of ["10min", "6h"] as const) {
        const { file, markdown } = seed(window);
        const model = vi.fn(async (_request: ChatRequest) => response(title));
        const { internal } = serviceAt(model);
        expect(await internal.writeSummaryWith(file, window, null)).toBe(true);
        expect(model).toHaveBeenCalledOnce();
        const request = model.mock.calls[0]![0];
        expect(request.messages[0]!.content).toContain(language === "zh-CN" ? "Simplified Chinese (zh-CN)"
          : language === "en-US" ? "English (en-US)" : `BCP 47 locale ${language}`);
        const updated = fs.readFileSync(file, "utf8");
        expect(updated).toContain(`# ${title}\n`);
        expect(updated).toContain("summary_state: ready");
        expect(updated.slice(updated.indexOf("## Citations"))).toBe(markdown.slice(markdown.indexOf("## Citations")));
      }
    }
  });

  it.each([
    ["en-US", "zh-CN", "检查部署版本"],
    ["fr-FR", "ja-JP", "デプロイを確認"],
  ])("does not commit or coalesce an old %s response after switching to %s", async (before, after, title) => {
    configureLanguage(before);
    const { file, markdown } = seed("10min");
    const replies: Array<(value: { content: string }) => void> = [];
    const model = vi.fn((_request: ChatRequest) => new Promise<{ content: string }>((resolve) => replies.push(resolve)));
    const { internal } = serviceAt(model);
    const previous = internal.writeSummaryWith(file, "10min", null);
    configureLanguage(after);
    const current = internal.writeSummaryWith(file, "10min", null);
    expect(model).toHaveBeenCalledTimes(2);
    replies[0]!(response("Old-language response"));
    expect(await previous).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(markdown);
    replies[1]!(response(title));
    expect(await current).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain(`# ${title}\n`);
  });

  it("leaves previously completed summaries untouched when the App language changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 11, 7));
    configureLanguage("zh-CN");
    const { file, markdown } = seed("10min", true);
    const model = vi.fn(async () => response("不应重新生成"));
    const { service } = serviceAt(model);
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(model).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe(markdown);
  });
});
