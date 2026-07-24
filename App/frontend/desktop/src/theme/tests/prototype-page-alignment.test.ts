/// <reference types="node" />
/** Prototype page alignment tests. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Handles source. */
function source(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), "utf8");
}

describe("prototype page structure alignment", () => {
  it("keeps the compiled prototype utility sheet inside the App source tree", () => {
    expect(existsSync(resolve(sourceRoot, "prototype-utilities.css"))).toBe(true);
    expect(source("styles.css")).toContain('@import "./prototype-utilities.css";');
  });

  it("aligns account entry pages with the prototype auth shell", () => {
    expect(source("pages/welcome-page.tsx")).toContain("h-screen flex flex-col bg-canvas-oat relative overflow-hidden");
    expect(source("pages/welcome-page.tsx")).toContain('dispatch(appActions.navigate("/token-detail"))');
    expect(source("pages/token-detail-page.tsx")).toContain("h-screen flex flex-col bg-canvas-oat relative overflow-hidden");
    expect(source("pages/token-detail-page.tsx")).toContain("bg-gradient-to-br from-action-sky to-action-sky-hover");
    expect(source("pages/token-detail-page.tsx")).toContain("30,000,000");
    expect(source("pages/login-page.tsx")).toContain("space-y-3.5");
    expect(source("components/nickname-modal.tsx")).toContain("rounded-card-lg shadow-lg");
  });

  it("aligns onboarding and main workspace pages with the prototype layout", () => {
    expect(source("pages/onboarding-page.tsx")).toContain("fixed inset-0 z-50 flex items-center justify-center bg-text-ink/30 backdrop-blur-sm");
    expect(source("pages/app-frame.tsx")).toContain("flex h-screen bg-canvas-oat");
    expect(source("pages/app-frame.tsx")).toContain("app-frame-sidebar flex flex-col");
    expect(source("pages/app-frame.tsx")).toContain("MessageSquarePlus");
    expect(source("pages/app-frame.tsx")).toContain("LayoutList");
    expect(source("pages/app-frame.tsx")).not.toContain('icon: "+"');
    expect(source("pages/app-frame.tsx")).not.toContain('icon: "M"');
    expect(source("pages/home-page.tsx")).toContain("app-frame-page-content home-empty-screen flex flex-col items-center justify-center h-full");
    expect(source("styles.css")).toContain(".home-empty-screen");
    expect(source("styles.css")).toContain("padding-bottom: 8%;");
    expect(source("pages/home-page.tsx")).toContain("text-center mb-8");
    expect(source("pages/home-page.tsx")).toContain("home-empty-brand-mascot flex justify-center");
    expect(source("pages/home-page.tsx")).toContain("text-2xl font-bold text-text-ink");
    expect(source("pages/home-page.tsx")).toContain("w-full max-w-2xl");
    expect(source("styles.css")).toContain(".home-empty-composer");
    expect(source("styles.css")).toContain(".agent-composer-shell");
    expect(source("pages/home-page.tsx")).toContain("relative home-empty-composer agent-composer-shell rounded-card-lg");
    expect(source("pages/home-page.tsx")).toContain("w-full px-5 pt-4 pb-12 text-sm resize-none focus:outline-none rounded-card-lg bg-background-paper placeholder:text-text-ink/40");
    expect(source("pages/home-page.tsx")).toContain("absolute bottom-3 right-4 flex items-center gap-2");
    expect(source("pages/home-page.tsx")).toContain('t("home.suggestion.heading")');
    expect(source("pages/home-page.tsx")).toContain('className="home-starter-prompts__grid"');
    expect(source("pages/home-page.tsx")).toContain('className="home-starter-prompt"');
    expect(source("styles.css")).toContain(".home-starter-prompts__grid");
    expect(source("styles.css")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(source("styles.css")).toContain(".home-starter-prompt:focus-visible");
    expect(source("styles.css")).toContain("@media (max-width: 720px)");
    expect(source("styles.css")).toContain("@media (max-height: 760px)");
    expect(source("pages/home-page.tsx")).toContain("agent-conversation-panel flex flex-col h-full");
    expect(source("pages/home-page.tsx")).toContain("app-frame-page-content agent-conversation-scroll flex-1 overflow-y-auto");
    expect(source("pages/home-page.tsx")).toContain("max-w-3xl mx-auto space-y-3");
    expect(source("pages/home-page.tsx")).toContain("relative agent-composer-shell rounded-card-lg");
    expect(source("pages/home-page.tsx")).not.toContain("relative overflow-hidden agent-composer-shell rounded-card-lg");
    expect(source("pages/home-page.tsx")).toContain('${isComposerSingleLine ? "agent-composer-input--single " : ""}block w-full pl-4 pr-20 py-3 text-sm resize-none focus:outline-none rounded-card-lg bg-background-paper placeholder:text-text-ink/40');
    expect(source("pages/home-page.tsx")).toContain('centerComposerControls ? "top-1/2 -translate-y-1/2" : "bottom-2"');
  });

  it("aligns utility pages with their prototype counterparts", () => {
    expect(source("pages/api-key-page.tsx")).toContain("min-h-screen bg-canvas-oat px-4 pt-4 pb-8 relative overflow-hidden");
    expect(source("pages/tools-page.tsx")).toContain("app-frame-page-content h-full overflow-y-auto py-6");
    expect(source("pages/tools-page.tsx")).toContain("tools-icon-grid");
    expect(source("styles.css")).toContain("grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));");
    expect(source("styles.css")).toContain("gap: 8px;");
    expect(source("styles.css")).toContain("gap: 12px;");
    expect(source("styles.css")).not.toContain("aspect-ratio: 1 / 1");
    expect(source("styles.css")).toContain(".integration-card-logo");
    expect(source("styles.css")).toContain(".integration-logo-badge");
    expect(source("styles.css")).toContain(".integration-logo-image");
    expect(source("styles.css")).toContain("width: 48px");
    expect(source("styles.css")).toContain("width: 32px");
    expect(source("styles.css")).toContain("max-width: 40px");
    expect(source("styles.css")).toContain("padding: 4px");
    expect(source("styles.css")).toContain("gap: 0;");
    expect(source("styles.css")).toContain("font-size: 11px");
    expect(source("styles.css")).toContain("font-size: 10px");
    expect(source("pages/memory-page.tsx")).toContain("min-w-0 flex-1 flex flex-col overflow-hidden bg-content-bg");
    expect(source("pages/memory-page.tsx")).toContain("icon: <Layers size={16}");
    expect(source("pages/memory-page.tsx")).toContain("app-frame-page-content min-h-0 flex-1 overflow-y-auto py-6");
    expect(source("pages/memory/overview-sub-page.tsx")).toContain("memory.overview.memories");
    expect(source("pages/memory/overview-sub-page.tsx")).toContain("memory.overview.worldModels");
    expect(source("pages/memory/overview-sub-page.tsx")).toContain("memory.overview.sourceDistribution");
    expect(source("pages/memory/memories-sub-page.tsx")).toContain("Search size={15}");
    expect(source("pages/memory/analytics-sub-page.tsx")).toContain("memory.analytics.sevenDayWrites");
    expect(source("pages/memory/analytics-sub-page.tsx")).toContain("memory.analytics.toolLatency");
    expect(source("pages/memory-sources-page.tsx")).toContain("h-full overflow-y-auto p-6");
    expect(source("pages/memory-sources-page.tsx")).toContain("showWipeConfirm");
    expect(source("pages/memory-sources-page.tsx")).toContain("ActionBtn");
    expect(source("pages/memory-sources-page.tsx")).toContain("FolderSearch");
    expect(source("pages/memory-sources-page.tsx")).toContain("AlertTriangle");
    expect(source("pages/memory-sources-page.tsx")).toContain("onClick={() => scanSources(source.sourceId)}");
    expect(source("pages/memory-sources-page.tsx")).not.toContain("onClick={scanSources}");
    expect(source("pages/memory-sources-page.tsx")).toContain('okLabel={t("memory.cliInstalled")}');
    expect(source("pages/memory-sources-page.tsx")).toContain('okLabel={t("memory.daemonRunning")}');
    expect(source("pages/memory-sources-page.tsx")).toContain('actionTone="success"');
    expect(source("pages/memory-sources-page.tsx")).toContain("window.memmy?.exportMemoryDatabase");
    expect(source("pages/memory-sources-page.tsx")).toContain("onClick={exportLocalData}");
    expect(source("pages/memory-sources-page.tsx")).toContain('className="flex items-center gap-2 mt-1"');
    expect(source("pages/memory-sources-page.tsx")).not.toContain("mt-1 flex-wrap");
    expect(source("pages/memory-sources-page.tsx")).toContain('"memory.installHook"');
    expect(source("pages/memory-sources-page.tsx")).toContain('"memory.installSkill"');
    expect(source("pages/memory-sources-page.tsx")).toContain('"memory.removePlugin"');
    expect(source("pages/memory-sources-page.tsx")).toContain("clients.agentSources.uninstallPlugin(source.sourceId)");
    expect(source("pages/memory-sources-page.tsx")).not.toContain('"memory.removeAgent"');
    expect(source("pages/memory-sources-page.tsx")).toContain("formatSourceDataPath(source.dataPath)");
    expect(source("pages/memory-sources-page.tsx")).toContain("formatSourceMemoryCount(source.messageCount, t)");
    expect(source("pages/memory-sources-page.tsx")).toContain("text-xs text-text-ink/50 shrink-0 whitespace-nowrap");
    expect(source("pages/memory-sources-page.tsx")).toContain("rounded-tag font-normal shrink-0 whitespace-nowrap");
    expect(source("pages/settings-page.tsx")).toContain("h-full overflow-y-auto");
    expect(source("pages/settings-page.tsx")).toContain('} from "lucide-react";');
    expect(source("pages/settings-page.tsx")).toContain("Brain, Palette, Rocket, Settings2, Shield, User, Zap");
    expect(source("pages/settings-page.tsx")).not.toContain('from "./memory/memory-prototype-icons.js"');
    expect(source("pages/pet-page.tsx")).toContain("fixed inset-0 bg-transparent pointer-events-none");
  });

  it("does not override prototype typography utilities on native controls", () => {
    expect(source("styles.css")).not.toContain("font: inherit;");
    expect(source("styles.css")).toContain("font-family: inherit;");
  });
});
