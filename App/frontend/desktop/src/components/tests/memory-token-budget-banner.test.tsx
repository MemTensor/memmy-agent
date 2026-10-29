// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryTokenBudgetDto } from "@memmy/local-api-contracts";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { MemoryTokenBudgetBanner, memoryTokenBudgetPauseEpisode, rememberPublishedMemoryBudget } from "../memory-token-budget-banner.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const styles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../styles.css"), "utf8");

describe("MemoryTokenBudgetBanner", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sessionStorage.clear();
    rememberPublishedMemoryBudget(null);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    sessionStorage.clear();
    rememberPublishedMemoryBudget(null);
  });

  it("does not render when the budget is not paused", async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner budget={budget({ paused: false, trigger: null })} onOpenSettings={vi.fn()} />
        </I18nProvider>
      );
    });
    expect(container.querySelector(".memory-token-budget-capsule")).toBeNull();
  });

  it("shows the compact capsule copy and opens settings from the body", async () => {
    const onOpenSettings = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner
            budget={budget({ paused: true, trigger: "total" })}
            onOpenSettings={onOpenSettings}
          />
        </I18nProvider>
      );
    });

    const open = container.querySelector<HTMLButtonElement>(".memory-token-budget-capsule__open");
    expect(open?.textContent).toContain("已达记忆进化任务累计 Token 限额，暂停后台记忆进化。对话、记忆读写仍可继续进行。");
    expect(open?.textContent).not.toContain("查看限额");
    expect(container.querySelector(".memory-token-budget-capsule__action")).toBeNull();
    expect(container.querySelector(".banner-danger")).toBeNull();
    container.querySelector<HTMLElement>(".memory-token-budget-capsule")?.click();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    open?.click();
    expect(onOpenSettings).toHaveBeenCalledTimes(2);
    expect(styles).toContain(".window-drag-exclusion--memory-budget-capsule");
    expect(styles).toMatch(/\.app-frame-content-topbar\s*\{[^}]*z-index: 10000;/s);
  });

  it("stays in the top bar flow without a full-width overlay", () => {
    const rule = styles.match(/\.memory-token-budget-capsule\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("min-height: 30px;");
    expect(rule).toContain("height: auto;");
    expect(rule).toContain("align-items: center;");
    expect(rule).toContain("line-height: 0;");
    expect(rule).toContain("max-width: 100%;");
    expect(styles).toMatch(/\.memory-token-budget-capsule__title\s*\{[^}]*text-align: center;[^}]*text-overflow: ellipsis;[^}]*white-space: normal;[^}]*-webkit-line-clamp: 2;/s);
    expect(rule).toContain("-webkit-app-region: no-drag;");
    expect(rule).not.toContain("font: inherit;");
    expect(styles).toContain(".memory-token-budget-capsule__open");
    expect(styles).toMatch(/\.memory-token-budget-capsule__open\s*\{[^}]*height: auto;/s);
    expect(styles).toMatch(/\.memory-token-budget-capsule__open\s*\{[^}]*font-family: inherit;/s);
    expect(styles).toMatch(/\.memory-token-budget-capsule__close\s*\{[^}]*height: 30px;/s);
    expect(rule).not.toContain("position: fixed;");
    expect(rule).not.toContain("height: 6px;");
    expect(styles).not.toContain("container-name: app-frame-topbar;");
    expect(styles).toContain(".app-frame-content-topbar__center");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, max-content) max-content;");
    expect(styles).toContain(".app-frame-content-topbar:has(.memory-token-budget-capsule)");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, max-content) minmax(max-content, 1fr);");
    expect(styles).toContain("--app-frame-topbar-sidebar-safe: calc(var(--codex-sidebar-hidden-topbar-padding) - var(--codex-content-padding-x));");
    expect(styles).toContain(
      "minmax(var(--app-frame-topbar-sidebar-safe), 1fr)\n    minmax(0, max-content)\n    minmax(var(--app-frame-topbar-sidebar-safe), 1fr);"
    );
    expect(styles).toMatch(
      /\.app-frame-content-topbar:has\(\.memory-token-budget-capsule\) \.app-frame-content-topbar__start\s*\{[^}]*box-sizing: border-box;[^}]*padding-left: var\(--app-frame-topbar-sidebar-safe\);/s
    );
    expect(styles).toMatch(/\.memory-token-budget-capsule\s*\{[^}]*min-width: 0;/s);
    expect(styles).toMatch(/\.app-frame-content-topbar__center\s*\{[^}]*overflow-x: hidden;/s);
    expect(styles).not.toContain("container-name: app-frame-topbar-center;");
    expect(styles).not.toContain(".memory-token-budget-banner {");
  });

  it("closes the capsule without opening settings and keeps it closed for the same pause", async () => {
    const onOpenSettings = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner
            budget={budget({ paused: true, trigger: "total" })}
            onOpenSettings={onOpenSettings}
          />
        </I18nProvider>
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".memory-token-budget-capsule__close")?.click();
    });
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(container.querySelector(".memory-token-budget-capsule")).toBeNull();

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner
            budget={budget({ paused: true, trigger: "total" })}
            onOpenSettings={onOpenSettings}
          />
        </I18nProvider>
      );
    });
    expect(container.querySelector(".memory-token-budget-capsule")).toBeNull();
  });

  it("renders from the published budget event when no override is passed", async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner onOpenSettings={vi.fn()} />
        </I18nProvider>
      );
    });
    expect(container.querySelector(".memory-token-budget-capsule")).toBeNull();

    await act(async () => {
      window.dispatchEvent(new CustomEvent("memmy:memory-token-budget-updated", {
        detail: budget({ paused: true, trigger: "total" })
      }));
    });
    expect(container.querySelector(".memory-token-budget-capsule")).not.toBeNull();
  });

  it("shows the capsule again after the pause episode changes", async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner
            budget={budget({ paused: true, trigger: "total" })}
            onOpenSettings={vi.fn()}
          />
        </I18nProvider>
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".memory-token-budget-capsule__close")?.click();
    });

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner
            budget={budget({ paused: true, trigger: "daily" })}
            onOpenSettings={vi.fn()}
          />
        </I18nProvider>
      );
    });
    expect(container.querySelector(".memory-token-budget-capsule")).not.toBeNull();
    expect(container.querySelector(".memory-token-budget-capsule__open")?.textContent).toContain("已达记忆进化任务今日 Token 限额，暂停后台记忆进化。对话、记忆读写仍可继续进行。");
  });

  it("shows the total capsule again after dismiss when only the daily limit changes", async () => {
    const bothOver = {
      ...budget({ paused: true, trigger: "total" }),
      dailyLimitM: 3,
      totalLimitM: 8
    };
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner budget={bothOver} onOpenSettings={vi.fn()} />
        </I18nProvider>
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".memory-token-budget-capsule__close")?.click();
    });
    expect(container.querySelector(".memory-token-budget-capsule")).toBeNull();
    expect(sessionStorage.getItem("memmy.memory-token-budget-banner.dismissed")).toBe(
      memoryTokenBudgetPauseEpisode(bothOver)
    );

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner
            budget={{ ...bothOver, dailyLimitM: 2 }}
            onOpenSettings={vi.fn()}
          />
        </I18nProvider>
      );
    });
    expect(container.querySelector(".memory-token-budget-capsule")).not.toBeNull();
    expect(container.querySelector(".memory-token-budget-capsule__open")?.textContent).toContain("已达记忆进化任务累计 Token 限额，暂停后台记忆进化。对话、记忆读写仍可继续进行。");
  });

  it("punches a titlebar drag hole over the visible capsule", async () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.classList?.contains("memory-token-budget-capsule")) {
        return {
          x: 240,
          y: 8,
          top: 8,
          left: 240,
          right: 520,
          bottom: 38,
          width: 280,
          height: 30,
          toJSON() {
            return {};
          }
        };
      }
      return original.call(this);
    };

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner
            budget={budget({ paused: true, trigger: "daily" })}
            onOpenSettings={vi.fn()}
          />
        </I18nProvider>
      );
    });

    try {
      const exclusion = document.querySelector<HTMLElement>(".window-drag-exclusion--memory-budget-capsule");
      expect(exclusion).not.toBeNull();
      expect(exclusion?.style.left).toBe("240px");
      expect(exclusion?.style.width).toBe("280px");
      expect(exclusion?.style.height).toBe("30px");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it("moves the drag exclusion when the topbar offset changes without a resize", async () => {
    let top = 54;
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.classList?.contains("memory-token-budget-capsule")) {
        return {
          x: 240,
          y: top,
          top,
          left: 240,
          right: 520,
          bottom: top + 30,
          width: 280,
          height: 30,
          toJSON() {
            return {};
          }
        };
      }
      return original.call(this);
    };

    await act(async () => {
      root.render(
        <div className="app-frame-main app-frame-main--windows-titlebar-safe">
          <header className="app-frame-content-topbar">
            <I18nProvider language="zh-CN">
              <MemoryTokenBudgetBanner
                budget={budget({ paused: true, trigger: "daily" })}
                onOpenSettings={vi.fn()}
              />
            </I18nProvider>
          </header>
        </div>
      );
    });

    try {
      const exclusion = document.querySelector<HTMLElement>(".window-drag-exclusion--memory-budget-capsule");
      expect(exclusion?.style.top).toBe("54px");
      top = 8;
      await act(async () => {
        document.querySelector(".app-frame-main")?.classList.remove("app-frame-main--windows-titlebar-safe");
      });
      expect(document.querySelector<HTMLElement>(".window-drag-exclusion--memory-budget-capsule")?.style.top).toBe("8px");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it("keeps a known pause visible after remount before a fresh budget response", async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner onOpenSettings={vi.fn()} />
        </I18nProvider>
      );
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent("memmy:memory-token-budget-updated", {
        detail: budget({ paused: true, trigger: "total" })
      }));
    });
    expect(container.querySelector(".memory-token-budget-capsule")).not.toBeNull();

    act(() => root.unmount());
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner onOpenSettings={vi.fn()} />
        </I18nProvider>
      );
    });
    expect(container.querySelector(".memory-token-budget-capsule")).not.toBeNull();
  });

  it("shows the capsule again after recovery then the same pause returns", async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner
            budget={budget({ paused: true, trigger: "total" })}
            onOpenSettings={vi.fn()}
          />
        </I18nProvider>
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".memory-token-budget-capsule__close")?.click();
    });

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner
            budget={{ ...budget({ paused: false, trigger: null }), totalLimitM: 0 }}
            onOpenSettings={vi.fn()}
          />
        </I18nProvider>
      );
    });
    expect(sessionStorage.getItem("memmy.memory-token-budget-banner.dismissed")).toBeNull();

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner
            budget={budget({ paused: true, trigger: "total" })}
            onOpenSettings={vi.fn()}
          />
        </I18nProvider>
      );
    });
    expect(container.querySelector(".memory-token-budget-capsule")).not.toBeNull();
  });

  it("shows the capsule again after a daily limit is cleared then reached", async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner
            budget={budget({ paused: true, trigger: "daily" })}
            onOpenSettings={vi.fn()}
          />
        </I18nProvider>
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".memory-token-budget-capsule__close")?.click();
    });

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner
            budget={{ ...budget({ paused: false, trigger: null }), dailyLimitM: 0 }}
            onOpenSettings={vi.fn()}
          />
        </I18nProvider>
      );
    });

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetBanner
            budget={budget({ paused: true, trigger: "daily" })}
            onOpenSettings={vi.fn()}
          />
        </I18nProvider>
      );
    });
    expect(container.querySelector(".memory-token-budget-capsule")).not.toBeNull();
  });

  it("includes both limits and midnight in the pause episode", () => {
    expect(memoryTokenBudgetPauseEpisode(budget({ paused: true, trigger: "daily" }))).toBe(
      "daily:2026-09-19T16:00:00.000Z:10:500"
    );
    expect(memoryTokenBudgetPauseEpisode(budget({ paused: true, trigger: "total" }))).toBe(
      "total:2026-09-19T16:00:00.000Z:10:500"
    );
    expect(memoryTokenBudgetPauseEpisode(budget({ paused: false, trigger: null }))).toBeNull();
  });
});

function budget(input: Pick<MemoryTokenBudgetDto, "paused" | "trigger">): MemoryTokenBudgetDto {
  return {
    dailyLimitM: 10,
    totalLimitM: 500,
    dailyUsed: 0,
    lifetimeUsed: 0,
    paused: input.paused,
    trigger: input.trigger,
    nextLocalMidnightAt: "2026-09-19T16:00:00.000Z"
  };
}
