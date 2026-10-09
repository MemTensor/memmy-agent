// @vitest-environment happy-dom

/** Connect integration modal DOM regression tests. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationsClient } from "../../api/integrations-client.js";
import type { IntegrationConnection } from "../../integrations/connection-state.js";
import type { IntegrationMeta } from "../../integrations/integration-meta.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ConnectIntegrationModal } from "../connect-integration-modal.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("ConnectIntegrationModal DOM regressions", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("连接失败后后台刷新不会清除服务不可用提示", async () => {
    const root = createRoot(document.createElement("div"));
    const client: IntegrationsClient = {
      authorize: vi.fn(async () => { throw new TypeError("fetch failed"); }),
      listCapabilities: vi.fn(async () => ({ toolkits: [] })),
      listConnections: vi.fn(async () => ({ connections: [] })),
      deleteConnection: vi.fn(async () => undefined),
      reportConnectionEvent: vi.fn(async () => undefined)
    };
    const render = (connection?: IntegrationConnection) => (
      <I18nProvider language="zh-CN">
        <ConnectIntegrationModal
          open
          integration={github}
          connection={connection}
          client={client}
          onClose={vi.fn()}
          onChanged={vi.fn()}
        />
      </I18nProvider>
    );

    try {
      await act(async () => root.render(render()));
      const connectButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("连接 GitHub"));
      expect(connectButton).toBeDefined();

      await act(async () => connectButton?.click());
      expect(document.body.textContent).toContain("服务暂时不可用，请稍后重新连接。");

      await act(async () => root.render(render({ id: "conn-github", toolkit: "github", status: "INITIATED" })));
      expect(document.body.textContent).toContain("服务暂时不可用，请稍后重新连接。");
    } finally {
      act(() => root.unmount());
    }
  });
});
