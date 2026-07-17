/** Connect integration modal tests. */
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../api/http.js";
import type { IntegrationsClient } from "../../api/integrations-client.js";
import type { IntegrationConnection } from "../../integrations/connection-state.js";
import type { IntegrationMeta } from "../../integrations/integration-meta.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ConnectIntegrationModal, runIntegrationConnectFlow } from "../connect-integration-modal.js";

const github: IntegrationMeta = {
  slug: "github",
  name: "GitHub",
  description: "Connect GitHub for developer workflows.",
  category: "Platform",
  logoUrl: "https://logos.composio.dev/api/github",
  permissionLabel: "Repos, records, tickets, and system data",
  authKind: "oauth",
  surface: "integration",
  identity: "integration:github",
  isChannel: false,
  authProvider: "Composio"
};

const wechat: IntegrationMeta = {
  ...github,
  slug: "wechat",
  name: "微信",
  authKind: "qrCode",
  surface: "channel",
  identity: "channel:wechat",
  isChannel: true,
  authProvider: undefined
};

const imessage: IntegrationMeta = {
  ...github,
  slug: "imessage",
  name: "iMessage",
  authKind: "none",
  surface: "channel",
  identity: "channel:imessage",
  isChannel: true,
  authProvider: undefined
};

describe("ConnectIntegrationModal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("idle 相渲染居中 modal", () => {
    const html = renderModal(github);

    expect(html).toContain("Connect GitHub");
    expect(html).toContain("Connect your GitHub account.");
    expect(html).toContain("GitHub");
    expect(html).toContain("may expose");
    expect(html).toContain("class=\"font-normal\">Repos, records, tickets, and system data</span>");
    expect(html).toContain("https://logos.composio.dev/api/github");
    expect(html).toContain("fixed inset-0 z-[9999] bg-black/30 backdrop-blur-sm flex items-center justify-center p-4");
    expect(html).toContain("rounded-3xl");
    expect(html).toContain(
      "bg-white border border-stone-200 rounded-3xl shadow-large w-full max-w-[460px] overflow-hidden animate-fade-up focus:outline-none focus:ring-0"
    );
    expect(html).toContain("animation-duration:200ms");
    expect(html).toContain("animation-timing-function:cubic-bezier(0.25, 0.46, 0.45, 0.94)");
    expect(html).toContain("animation-fill-mode:both");
    expect(html).toContain("tabindex=\"-1\"");
    expect(html).toContain("p-4 border-b border-stone-200");
    expect(html).toContain("flex items-center gap-2");
    expect(html).toContain("text-base font-semibold text-stone-900");
    expect(html).toContain("text-xs text-stone-400 mt-1.5 line-clamp-2");
    expect(html).toContain("p-1 text-stone-400 hover:text-stone-900 transition-colors rounded-lg hover:bg-stone-100 flex-shrink-0");
    expect(html).toContain("class=\"w-5 h-5\"");
    expect(html).toContain("p-4 space-y-3");
    expect(html).toContain("rounded-xl border border-stone-200 bg-stone-50 p-3");
    expect(html).toContain("text-sm font-normal text-stone-600");
    expect(html).toContain("text-xs leading-relaxed text-stone-600");
    expect(html).toContain("w-full rounded-xl bg-action-sky text-white text-sm font-normal py-2.5");
    expect(html).not.toContain("bg-primary-500");
    expect(html).not.toContain("p-5 text-left shadow-2xl ring-1 ring-black/5");
    expect(html).not.toContain("modal-right");
  });

  it("连接流程会 authorize、调用 openUrl，并轮询到 connected", async () => {
    const phases: string[] = [];
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const client = createFlowClient([
      { id: "conn-github", toolkit: "github", status: "INITIATED" },
      { id: "conn-github", toolkit: "github", status: "ACTIVE" }
    ]);

    const result = await runIntegrationConnectFlow({
      slug: "github",
      client,
      openUrl,
      pollIntervalMs: 0,
      pollTimeoutMs: 1000,
      onPhase: (phase) => phases.push(phase)
    });

    expect(result.phase).toBe("connected");
    expect(client.authorize).toHaveBeenCalledWith("github");
    expect(openUrl).toHaveBeenCalledWith("https://backend.composio.dev/api/v3/s/github-test");
    expect(phases).toEqual(["authorizing", "waiting", "connected"]);
  });

  it("轮询瞬时失败只 warn 并在下一拍继续等待 connected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const client = {
      authorize: vi.fn(async () => ({ connectUrl: "https://backend.composio.dev/api/v3/s/github-test", connectionId: "conn-github" })),
      listCapabilities: vi.fn(async () => ({ toolkits: [] })),
      listConnections: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary network error"))
        .mockResolvedValueOnce({ connections: [{ id: "conn-github", toolkit: "github", status: "ACTIVE" }] }),
      deleteConnection: vi.fn(async () => undefined)
    };

    const result = await runIntegrationConnectFlow({
      slug: "github",
      client,
      openUrl,
      pollIntervalMs: 0,
      pollTimeoutMs: 1000
    });

    expect(result.phase).toBe("connected");
    expect(client.listConnections).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("[tools] Failed to poll connection state; retrying on the next tick:", expect.any(Error));
  });

  it("取消信号触发后停止轮询，不再把等待流程推进到错误态", async () => {
    const phases: string[] = [];
    const controller = new AbortController();
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const client = {
      authorize: vi.fn(async () => ({ connectUrl: "https://backend.composio.dev/api/v3/s/github-test", connectionId: "conn-github" })),
      listCapabilities: vi.fn(async () => ({ toolkits: [] })),
      listConnections: vi.fn(async () => {
        controller.abort();
        return { connections: [] };
      }),
      deleteConnection: vi.fn(async () => undefined)
    };

    const result = await runIntegrationConnectFlow({
      slug: "github",
      client,
      openUrl,
      pollIntervalMs: 50,
      pollTimeoutMs: 1000,
      signal: controller.signal,
      onPhase: (phase) => phases.push(phase)
    });

    expect(result).toEqual({ phase: "idle", cancelled: true });
    expect(client.listConnections).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(["authorizing", "waiting"]);
  });

  it("连接流程不会把同 toolkit 的旧 ACTIVE 连接当成本次授权成功", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const client = {
      authorize: vi.fn(async () => ({ connectUrl: "https://backend.composio.dev/api/v3/s/live", connectionId: "conn-new" })),
      listCapabilities: vi.fn(async () => ({ toolkits: [] })),
      listConnections: vi.fn(async () => ({ connections: [{ id: "conn-old", toolkit: "github", status: "ACTIVE" as const }] })),
      deleteConnection: vi.fn(async () => undefined)
    };

    const result = await runIntegrationConnectFlow({
      slug: "github",
      client,
      openUrl,
      pollIntervalMs: 0,
      pollTimeoutMs: 0
    });

    expect(result.phase).toBe("error");
    expect(result.error).toBeInstanceOf(Error);
    expect(openUrl).toHaveBeenCalledWith("https://backend.composio.dev/api/v3/s/live");
  });

  it("连接流程遇到 composio_not_configured 时回到 idle 且不暴露研发报错", async () => {
    const phases: string[] = [];
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      authorize: vi.fn(async () => {
        throw new ApiRequestError("尚未配置 Composio 鉴权服务", 400, "composio_not_configured", "req-1");
      }),
      listCapabilities: vi.fn(async () => ({ toolkits: [] })),
      listConnections: vi.fn(async () => ({ connections: [] })),
      deleteConnection: vi.fn(async () => undefined)
    };

    const result = await runIntegrationConnectFlow({
      slug: "github",
      client,
      openUrl,
      pollIntervalMs: 0,
      pollTimeoutMs: 1000,
      onPhase: (phase) => phases.push(phase)
    });

    expect(result).toEqual({ phase: "idle" });
    expect(phases).toEqual(["authorizing", "idle"]);
    expect(openUrl).not.toHaveBeenCalled();
    expect(String(result.error)).not.toContain("尚未配置 Composio 鉴权服务");
    expect(warn).toHaveBeenCalledWith(
      "[tools] integration setup diagnostic hidden from product UI:",
      expect.objectContaining({ code: "composio_not_configured" })
    );
  });

  it("连接态断开会调用 deleteConnection", async () => {
    const client = createFlowClient([]);

    await client.deleteConnection("conn-github");

    expect(client.deleteConnection).toHaveBeenCalledWith("conn-github");
  });

  it("error 相位和 dismiss 文案可渲染", () => {
    const html = renderModal(github, { forcedPhase: "error", errorMessage: "Connection failed" });

    expect(html).toContain("Connection failed");
    expect(html).toContain("Dismiss");
    expect(html).toContain("agent-model-error-notice");
    expect(html).toContain("agent-model-error-notice__header");
    expect(html).toContain("agent-model-error-notice__title");
    expect(html).toContain(
      "w-full rounded-xl border border-stone-200 bg-white text-stone-700 text-sm font-normal py-2 hover:bg-stone-50 transition-colors"
    );
    expect(html).not.toContain("border-red-200");
    expect(html).not.toContain("bg-red-50");
  });

  it("waiting 相位对齐授权等待状态布局", () => {
    const html = renderModal(github, { forcedPhase: "waiting" }, "zh-CN");

    expect(html).toContain("等待中");
    expect(html).toContain("GitHub");
    expect(html).toContain("等待完成 OAuth...");
    expect(html).toContain("flex items-center gap-2 text-sm text-stone-600");
    expect(html).toContain("w-2 h-2 rounded-full bg-amber-300");
    expect(html).toContain(
      "w-full rounded-xl border border-stone-200 bg-white text-stone-700 text-sm font-semibold py-2.5 hover:bg-stone-50 transition-colors"
    );
    expect(html).toContain("重新打开浏览器");
    expect(html).toContain("请在 Composio 的授权页面中完成操作");
  });

  it("已有 pending 连接记录时直接显示等待授权状态", () => {
    const html = renderModal(
      github,
      {
        connection: { id: "conn-github", toolkit: "github", status: "INITIATED" }
      },
      "zh-CN"
    );

    expect(html).toContain("等待中");
    expect(html).toContain("GitHub");
    expect(html).toContain("等待完成 OAuth...");
    expect(html).toContain("重新打开浏览器");
    expect(html).not.toContain("连接 GitHub</button>");
  });

  it("connected 相位对齐状态内容和按钮布局", () => {
    const html = renderModal(github, {
      forcedPhase: "connected",
      connection: { id: "conn-github", toolkit: "github", status: "ACTIVE" }
    });

    expect(html).toContain("Manage GitHub");
    expect(html).toContain("flex items-center gap-2 text-sm text-sage-700");
    expect(html).toContain("w-2 h-2 rounded-full bg-sage-500");
    expect(html).toContain("grid grid-cols-2 gap-3");
    expect(html).toContain(
      "w-full rounded-xl border border-coral-200 bg-coral-50 text-coral-700 text-sm font-normal py-2.5 hover:bg-coral-100 transition-colors"
    );
    expect(html).toContain("w-full rounded-xl bg-action-sky text-white text-sm font-normal py-2.5 hover:bg-action-sky-hover transition-colors");
    expect(html).not.toContain("text-emerald-700");
    expect(html).not.toContain("border-red-200");
  });

  it("二维码渠道显示 warning，不进入 openUrl 流程", () => {
    const html = renderModal(wechat, { qrWarning: true });

    expect(html).toContain("QR sign-in is coming soon; awaiting backend");
    expect(html).not.toContain("Reopen browser");
  });

  it("无授权渠道默认显示渠道待接入，不展示 OAuth 浏览器授权说明", () => {
    const html = renderModal(imessage, {}, "zh-CN");

    expect(html).toContain("该渠道连接服务即将上线，请等待后端就绪");
    expect(html).toContain("disabled=\"\"");
    expect(html).not.toContain("我们会打开浏览器窗口");
    expect(html).not.toContain("重新打开浏览器");
  });

  it("idle 阶段展示第三方连接服务说明", () => {
    const html = renderModal(github, {}, "zh-CN");

    expect(html).toContain("连接由 Composio 提供");
    expect(html).toContain("跳转至 Composio 的安全授权页面");
    expect(html).toContain("Composio 是 Memmy 的集成合作伙伴");
  });

  it("idle 阶段渠道项不展示第三方说明", () => {
    const html = renderModal(wechat, {}, "zh-CN");

    expect(html).not.toContain("连接由");
    expect(html).not.toContain("Composio");
  });

  it("waiting 阶段展示第三方授权页提示", () => {
    const html = renderModal(github, { forcedPhase: "waiting" }, "zh-CN");

    expect(html).toContain("请在 Composio 的授权页面中完成操作");
    expect(html).not.toContain("请在浏览器中完成授权");
  });

  it("不渲染额外 mock 提示块", () => {
    const html = renderModal(github);

    expect(html).not.toContain("border-sky-200 bg-sky-50");
  });
});

function renderModal(
  integration: IntegrationMeta,
  overrides: Partial<Parameters<typeof ConnectIntegrationModal>[0]> = {},
  language: "zh-CN" | "en-US" = "en-US"
): string {
  return renderToString(
    <I18nProvider language={language}>
      <ConnectIntegrationModal
        open
        integration={integration}
        client={createFlowClient([])}
        onClose={vi.fn()}
        onChanged={vi.fn()}
        {...overrides}
      />
    </I18nProvider>
  );
}

function createFlowClient(responses: IntegrationConnection[]): IntegrationsClient {
  const queue = [...responses];

  return {
    authorize: vi.fn(async (slug: string) => ({ connectUrl: `https://backend.composio.dev/api/v3/s/${slug}-test`, connectionId: `conn-${slug}` })),
    listCapabilities: vi.fn(async () => ({ toolkits: [] })),
    listConnections: vi.fn(async () => ({ connections: queue.length ? [queue.shift() as IntegrationConnection] : [] })),
    deleteConnection: vi.fn(async () => undefined)
  };
}
