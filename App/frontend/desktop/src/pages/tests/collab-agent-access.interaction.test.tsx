// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabAgentAccessView, CollabClient } from "../../api/collab-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabAgentAccessDialog } from "../collab-agent-access-dialog.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view: CollabAgentAccessView = {
  granted: false,
  askedInProject: false,
  agents: [
    { sourceId: "cursor", name: "Cursor", available: true, enabled: true, installed: false, added: false },
    { sourceId: "codex", name: "Codex", available: true, enabled: true, installed: false, added: false },
    { sourceId: "workbuddy", name: "WorkBuddy", available: true, enabled: false, installed: false, added: false }
  ]
};

let root: Root;
let container: HTMLDivElement;
const onDecided = vi.fn();
const onClose = vi.fn();

function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
}

async function render(client: CollabClient) {
  await act(async () => root.render(
    <I18nProvider language="zh-CN">
      <CollabAgentAccessDialog open collab={client} onDecided={onDecided} onClose={onClose} />
    </I18nProvider>
  ));
}

function client(overrides: Partial<CollabClient> = {}): CollabClient {
  return {
    getAgentAccess: vi.fn().mockResolvedValue(view),
    setAgentAccess: vi.fn(),
    installAgentAccess: vi.fn(),
    ...overrides
  } as unknown as CollabClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("collab agent access dialog", () => {
  it("lists the agents to set up, leaving out the ones turned off in settings", async () => {
    await render(client());
    expect(document.body.textContent).toContain("授权后，你可以：");
    expect(document.body.textContent).toContain("Cursor");
    expect(document.body.textContent).toContain("Codex");
    // 设置里关掉的不在安装清单里，只用一句话说明。
    expect(document.body.textContent).toContain("WorkBuddy 已关闭，不包含在内。");
  });

  it("shows the install results per agent, lets a failure be retried, then reports the decision", async () => {
    const failing = client({
      setAgentAccess: vi.fn().mockResolvedValue({
        view: { ...view, granted: true },
        results: [
          { sourceId: "cursor", name: "Cursor", ok: true },
          { sourceId: "codex", name: "Codex", ok: false, message: "技能目录不存在" }
        ]
      }),
      installAgentAccess: vi.fn().mockResolvedValue({
        view: { ...view, granted: true },
        results: [{ sourceId: "codex", name: "Codex", ok: true }]
      })
    });
    await render(failing);

    await act(async () => button("授权")?.click());
    // 装完换成结果页：逐个状态 + 一句可直接照说的话，暂时不结束。
    expect(document.body.textContent).toContain("已在 1 个 Agent 中安装，1 个未成功");
    expect(document.body.textContent).toContain("安装失败");
    expect(document.body.textContent).toContain("例如在 Cursor 中说：");
    expect(onDecided).not.toHaveBeenCalled();

    await act(async () => button("重试")?.click());
    expect(failing.installAgentAccess).toHaveBeenCalledWith(["codex"]);
    expect(document.body.textContent).toContain("已在 2 个 Agent 中安装");

    await act(async () => button("完成")?.click());
    expect(onDecided).toHaveBeenCalledWith(true, expect.arrayContaining([{ sourceId: "codex", name: "Codex", ok: true }]));
  });

  it("closes without granting when the person chooses not now", async () => {
    await render(client());
    await act(async () => button("暂不授权")?.click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(onDecided).not.toHaveBeenCalled();
  });
});
