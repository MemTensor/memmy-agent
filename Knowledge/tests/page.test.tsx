// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { KnowledgePage } from "../src/ui/page.js";
import type { KnowledgeSettings } from "../src/types.js";

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
it("shows management only, with recall off by default and no exposed saved secret", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state: KnowledgeSettings = {
    authenticated: true,
    enabled: false,
    serviceAvailable: true,
    bases: [{ id: "base-1", name: "差旅制度", selected: false }],
  };
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).includes("/files"))
        return new Response(JSON.stringify({ files: [], total: 0, page: 1 }));
      if (body?.enabled !== undefined) state.enabled = body.enabled;
      if (Array.isArray(body?.selectedIds))
        state.bases.forEach(
          (base) =>
            (base.selected = (body.selectedIds as string[]).includes(base.id)),
        );
      return new Response(JSON.stringify(state));
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <KnowledgePage
        connection={{
          baseUrl: "http://localhost:1234",
          localToken: "local-test",
        }}
      />,
    );
  });
  const toggle = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="switch"]'),
  ].find((item) =>
    (item.getAttribute("aria-label") ?? "").includes("差旅制度"),
  )!;
  expect(toggle).toBeDefined();
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.disabled).toBe(false);
  expect(container.textContent).toContain("差旅制度");
  expect(container.querySelector("textarea")).toBeNull();
  const fileInput =
    container.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(fileInput.multiple).toBe(true);
  expect(fileInput.hidden).toBe(true);
  const emptyCta = container.querySelector<HTMLElement>(".mk-empty-cta")!;
  expect(emptyCta.textContent).toContain("上传文件");
  expect(container.textContent).toContain("每个文件最多 20 MB");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(container.textContent).not.toContain("API Key");
  expect(container.textContent).not.toContain("MemOS 云服务连接");
  expect(container.querySelector('a[href*="memos-dashboard"]')).toBeNull();
  expect(calls.some((call) => call.url.includes("/credentials/reveal"))).toBe(
    false,
  );
  expect(calls.some((call) => call.url.includes("search"))).toBe(false);
  await act(async () => {
    toggle.click();
  });
  expect(
    calls.some(
      (call) =>
        call.body?.enabled === true &&
        Array.isArray(call.body?.selectedIds) &&
        (call.body.selectedIds as string[]).includes("base-1"),
    ),
  ).toBe(true);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});
