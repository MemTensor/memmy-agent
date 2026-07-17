/// <reference types="node" />
/** Style alignment tests. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tokenCss = readFileSync(resolve(sourceRoot, "theme/tokens.css"), "utf8");
const globalCss = readFileSync(resolve(sourceRoot, "styles.css"), "utf8");
const settingsTokenUsageCss = readFileSync(resolve(sourceRoot, "pages/settings-token-usage.module.css"), "utf8");

describe("prototype style alignment", () => {
  it("uses prototype design tokens as the primary visual source", () => {
    expect(tokenCss).toContain("--color-canvas-oat: #f3f8f7");
    expect(tokenCss).toContain("--color-background-paper: #ffffff");
    expect(tokenCss).toContain("--color-action-sky: #5cbfae");
    expect(tokenCss).toContain("--color-icon-ember: #f59e6b");
    expect(tokenCss).toContain("--radius-card: 12px");
    expect(tokenCss).toContain("--radius-card-lg: 10px");
    expect(tokenCss).toContain("--radius-pill: 9999px");
    expect(tokenCss).toContain('"Nunito"');
    expect(tokenCss).toContain('--font-sans: "Nunito", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC"');
    expect(tokenCss).toContain('"Apple Color Emoji"');
    expect(tokenCss).toContain('"Segoe UI Emoji"');
    expect(tokenCss).toContain("--codex-toolbar-height: 46px");
    expect(tokenCss).toContain("--codex-sidebar-nav-icon-inset: 28px");
    expect(tokenCss).toContain("--codex-window-control-inset: 84px");
    expect(tokenCss).toContain("--codex-sidebar-hidden-topbar-padding: 124px");
    expect(tokenCss).toContain("--codex-sidebar-width: 250px");
    expect(tokenCss).toContain("--codex-sidebar-min-width: 240px");
    expect(tokenCss).toContain("--codex-content-padding-x: 32px");
    expect(tokenCss).toContain("--codex-text-base: 14px");
    expect(tokenCss).toContain("--codex-leading-base: 20px");
    expect(globalCss).toContain('font-family: "Nunito";');
    expect(globalCss).toContain("nunito-latin-400-normal.woff2");
    expect(globalCss).toContain("nunito-latin-800-normal.woff2");
    expect(existsSync(resolve(sourceRoot, "assets/fonts/nunito-latin-400-normal.woff2"))).toBe(true);
    expect(existsSync(resolve(sourceRoot, "assets/fonts/nunito-latin-800-normal.woff2"))).toBe(true);
  });

  it("hides scrollbars globally while preserving scroll behavior", () => {
    const universalRule = globalCss.match(/\*\s*\{[^}]*\}/)?.[0] ?? "";
    const webkitScrollbarRule = globalCss.match(/\*::-webkit-scrollbar\s*\{[^}]*\}/)?.[0] ?? "";

    expect(universalRule).toContain("scrollbar-width: none;");
    expect(universalRule).toContain("-ms-overflow-style: none;");
    expect(webkitScrollbarRule).toContain("display: none;");
    expect(globalCss).not.toContain("*::-webkit-scrollbar-thumb");
  });

  it("does not expose dark theme token overrides", () => {
    expect(tokenCss).not.toContain('data-theme="dark"');
    expect(tokenCss).not.toContain("color-scheme: dark");
  });

  it("keeps prototype global interaction and mascot animations available", () => {
    expect(globalCss).toContain("@keyframes memmy-bob");
    expect(globalCss).toContain("@keyframes memmy-wave");
    expect(globalCss).toContain("@keyframes pet-idle-breath");
    expect(globalCss).toContain("@keyframes walkie-wave-pulse");
    expect(globalCss).toContain(".check-sky");
  });

  it("keeps screen-reader-only status text hidden visually", () => {
    const srOnlyRule = globalCss.match(/\.sr-only\s*\{[^}]*\}/)?.[0] ?? "";

    expect(srOnlyRule).toContain("position: absolute;");
    expect(srOnlyRule).toContain("width: 1px;");
    expect(srOnlyRule).toContain("height: 1px;");
    expect(srOnlyRule).toContain("overflow: hidden;");
    expect(srOnlyRule).toContain("clip: rect(0, 0, 0, 0);");
  });

  it("keeps desktop and memory sidebars attached to a draggable separator", () => {
    const appSidebarRule = globalCss.match(/\.app-frame-sidebar\s*\{[^}]*\}/)?.[0] ?? "";
    const appNavButtonRule = globalCss.match(/\.app-frame-nav-button,\s*\.app-frame-footer-action\s*\{[^}]*\}/)?.[0] ?? "";
    const appNavButtonLayoutRule = globalCss.match(/\.app-frame-nav-button\s*\{[^}]*\}/)?.[0] ?? "";
    const appFooterActionLayoutRule = Array.from(globalCss.matchAll(/^\.app-frame-footer-action\s*\{[^}]*\}/gm)).at(-1)?.[0] ?? "";
    const appSearchBoxRule = globalCss.match(/\.app-frame-search-box\s*\{[^}]*\}/)?.[0] ?? "";
    const appNavIconRule = globalCss.match(/\.app-frame-nav-button svg,\s*\.app-frame-footer-action svg\s*\{[^}]*\}/)?.[0] ?? "";
    const appTaskTitleRule = globalCss.match(/\.app-frame-task-title\s*\{[^}]*\}/)?.[0] ?? "";
    const sidebarWindowToolbarRule = globalCss.match(/\.sidebar-window-toolbar\s*\{[^}]*\}/)?.[0] ?? "";
    const sidebarToolbarButtonRule = globalCss.match(/\.sidebar-toolbar-button,\s*\.sidebar-restore-button\s*\{[^}]*\}/)?.[0] ?? "";
    const sidebarToolbarIconRule = globalCss.match(/\.sidebar-toolbar-button svg,\s*\.sidebar-restore-button svg\s*\{[^}]*\}/)?.[0] ?? "";
    const sidebarTransitionRule = globalCss.match(/\.sidebar-shell \.app-frame-sidebar,\s*\.sidebar-shell \.memory-page-sidebar\s*\{[^}]*\}/)?.[0] ?? "";
    const hiddenSidebarRule = globalCss.match(/\.sidebar-shell--hidden \.app-frame-sidebar,\s*\.sidebar-shell--hidden \.memory-page-sidebar\s*\{[^}]*\}/)?.[0] ?? "";
    const hiddenResizeHandleRule = globalCss.match(/\.sidebar-shell--hidden \.sidebar-resize-handle\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryTitleRowRule = globalCss.match(/\.memory-page-title-row,\s*\.memory-page-content-title\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryTitleTextRule = globalCss.match(/\.memory-page-title,\s*\.memory-page-content-title\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryPanelRule = globalCss.match(/\.memory-panel\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryPageSectionRule = globalCss.match(/\.memory-page-section\s*\{[^}]*\}/)?.[0] ?? "";
    const memorySingleLineHeaderRule = globalCss.match(/\.memory-panel__header--single-line\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryHeaderActionsRule = globalCss.match(/\.memory-panel__header-actions\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryPanelTitleRule = globalCss.match(/\.memory-panel__title\s*\{[^}]*\}/)?.[0] ?? "";
    const memorySidebarRule = Array.from(globalCss.matchAll(/^\.memory-page-sidebar\s*\{[^}]*\}/gm)).at(-1)?.[0] ?? "";
    const memoryToolbarRule = globalCss.match(/\.memory-page-toolbar\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryReturnRowRule = globalCss.match(/\.memory-page-return-row\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryBackButtonRule = globalCss.match(/\.memory-page-back-button\s*\{[^}]*\}/)?.[0] ?? "";
    const memorySectionHeaderRule = globalCss.match(/\.memory-page-section-header\s*\{[^}]*\}/)?.[0] ?? "";
    const sidebarToolbarPositionRule = globalCss.match(/\.sidebar-toolbar-button\s*\{[^}]*\}/)?.[0] ?? "";
    const sidebarRestoreButtonRule = Array.from(globalCss.matchAll(/\.sidebar-restore-button\s*\{[^}]*\}/g)).at(-1)?.[0] ?? "";
    const dragRegionRule = globalCss.match(/\.window-drag-region\s*\{[^}]*\}/)?.[0] ?? "";
    const dragExclusionRule = globalCss.match(/\.window-drag-exclusion\s*\{[^}]*\}/)?.[0] ?? "";
    const sidebarToggleExclusionRule = globalCss.match(/\.window-drag-exclusion--sidebar-toggle\s*\{[^}]*\}/)?.[0] ?? "";
    const edgeAlignedWindowControlsRule = globalCss.match(/body\.memmy-platform-windows,\s*body\.memmy-window-fullscreen\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryDrawerDragTrimRule = globalCss.match(/body:has\(\.memory-drawer\)\s+\.window-drag-region\s*\{[^}]*\}/)?.[0] ?? "";
    const resizeHandleRule = Array.from(globalCss.matchAll(/^\.sidebar-resize-handle\s*\{[^}]*\}/gm)).at(-1)?.[0] ?? "";

    expect(appSidebarRule).toContain("width: var(--codex-sidebar-width);");
    expect(appSidebarRule).toContain("flex: 0 0 var(--codex-sidebar-width);");
    expect(appSidebarRule).toContain("font-family: var(--font-sans);");
    expect(appSidebarRule).toContain("font-size: var(--codex-text-base);");
    expect(appSidebarRule).toContain("line-height: var(--codex-leading-base);");
    expect(appNavButtonRule).toContain("font-size: 13px;");
    expect(appNavButtonRule).toContain("line-height: 18px;");
    expect(appNavButtonLayoutRule).toContain("width: calc(100% - 32px);");
    expect(appNavButtonLayoutRule).toContain("margin: 0 16px;");
    expect(appNavButtonLayoutRule).toContain("padding: 8px 12px;");
    const appNavButtonActiveRule = globalCss.match(/\.app-frame-nav-button--active\s*\{[^}]*\}/)?.[0] ?? "";
    expect(appNavButtonActiveRule).toContain("color: var(--color-action-sky-hover);");
    expect(appNavButtonActiveRule).toContain("background: var(--color-nav-active-bg);");
    expect(tokenCss).toContain("--color-nav-active-bg: color-mix(in srgb, var(--color-action-sky) 16%, white);");
    expect(appFooterActionLayoutRule).toContain("width: calc(100% - 16px);");
    expect(appFooterActionLayoutRule).toContain("margin: 0 8px;");
    expect(appFooterActionLayoutRule).toContain("padding: 0 10px;");
    expect(appSearchBoxRule).toContain("width: calc(100% - 4px);");
    expect(appSearchBoxRule).toContain("margin: 0 2px;");
    expect(appSearchBoxRule).toContain("padding: 0 16px;");
    expect(appNavIconRule).toContain("width: var(--codex-icon-xs);");
    expect(appNavIconRule).toContain("height: var(--codex-icon-xs);");
    expect(appTaskTitleRule).toContain("font-size: 13px;");
    expect(globalCss).not.toContain(".app-frame-brand");
    expect(sidebarWindowToolbarRule).toContain("flex: 0 0 var(--codex-toolbar-height);");
    expect(sidebarWindowToolbarRule).toContain("min-height: var(--codex-toolbar-height);");
    expect(sidebarWindowToolbarRule).toContain("-webkit-app-region: drag;");
    expect(sidebarToolbarButtonRule).toContain("width: var(--codex-toolbar-button-size);");
    expect(sidebarToolbarButtonRule).toContain("height: var(--codex-toolbar-button-size);");
    expect(sidebarToolbarIconRule).toContain("width: var(--codex-icon-xs);");
    expect(sidebarToolbarIconRule).toContain("height: var(--codex-icon-xs);");
    expect(sidebarToolbarPositionRule).toContain("top: calc((var(--codex-toolbar-height) - var(--codex-toolbar-button-size)) / 2 - 2px);");
    expect(sidebarToolbarPositionRule).toContain("left: var(--codex-window-control-inset);");
    expect(sidebarRestoreButtonRule).toContain("top: calc((var(--codex-toolbar-height) - var(--codex-toolbar-button-size)) / 2 - 2px);");
    expect(sidebarRestoreButtonRule).toContain("left: var(--codex-window-control-inset);");
    expect(globalCss).toContain(".app-frame-main--sidebar-hidden .app-frame-content-topbar");
    expect(globalCss).toContain("padding-left: var(--codex-sidebar-hidden-topbar-padding);");
    expect(globalCss).toContain("body.memmy-window-fullscreen");
    expect(edgeAlignedWindowControlsRule).toContain("--codex-window-control-inset: calc(");
    expect(edgeAlignedWindowControlsRule).toContain("var(--codex-sidebar-nav-icon-inset)");
    expect(edgeAlignedWindowControlsRule).toContain("--codex-sidebar-hidden-topbar-padding: calc(");
    expect(sidebarTransitionRule).toBe("");
    expect(hiddenSidebarRule).toContain("overflow: hidden;");
    expect(hiddenSidebarRule).toContain("border-right-width: 0;");
    expect(hiddenResizeHandleRule).toBe("");
    expect(globalCss).toContain(".sidebar-resize-handle--disabled");
    expect(globalCss).toContain("pointer-events: none;");
    expect(memoryTitleRowRule).toContain("min-height: 20px;");
    expect(memoryTitleRowRule).toContain("align-items: center;");
    expect(memoryTitleTextRule).toContain("line-height: 20px;");
    expect(memoryPanelRule).toContain("padding: 0;");
    expect(memoryPanelRule).not.toContain("padding-top: 12px;");
    expect(memoryPageSectionRule).not.toContain("padding-top: 12px;");
    expect(memorySingleLineHeaderRule).toContain("align-items: flex-start;");
    expect(memoryHeaderActionsRule).toContain("align-self: flex-start;");
    expect(memoryHeaderActionsRule).toContain("transform: translateY(-7px);");
    expect(memoryPanelTitleRule).toContain("min-height: 20px;");
    expect(memoryPanelTitleRule).toContain("line-height: 20px;");
    expect(memorySidebarRule).toContain("width: var(--codex-sidebar-width);");
    expect(memorySidebarRule).toContain("flex: 0 0 var(--codex-sidebar-width);");
    expect(memorySidebarRule).toContain("padding-top: 0;");
    expect(memoryToolbarRule).toContain("flex: 0 0 var(--codex-toolbar-height);");
    expect(memoryToolbarRule).toContain("min-height: var(--codex-toolbar-height);");
    expect(memoryReturnRowRule).toContain("padding: 6px 14px 12px 30px;");
    expect(memoryBackButtonRule).toContain("height: 32px;");
    expect(memoryBackButtonRule).toContain("gap: 10px;");
    expect(memoryBackButtonRule).toContain("font-size: var(--codex-text-base);");
    expect(memorySectionHeaderRule).toContain("padding: 0 14px 0 30px;");
    expect(dragRegionRule).toContain("position: fixed;");
    expect(dragRegionRule).toContain("right: 0;");
    expect(dragRegionRule).toContain("left: 0;");
    expect(dragRegionRule).toContain("z-index: 9998;");
    expect(dragRegionRule).toContain("height: var(--codex-toolbar-height);");
    expect(dragRegionRule).toContain("pointer-events: none;");
    expect(dragRegionRule).toContain("user-select: none;");
    expect(dragRegionRule).not.toContain("background:");
    expect(dragRegionRule).not.toContain("backdrop-filter:");
    expect(dragRegionRule).toContain("-webkit-app-region: drag;");
    expect(dragExclusionRule).toContain("position: fixed;");
    expect(dragExclusionRule).toContain("z-index: 9999;");
    expect(dragExclusionRule).toContain("height: var(--codex-toolbar-height);");
    expect(dragExclusionRule).toContain("pointer-events: none;");
    expect(dragExclusionRule).toContain("-webkit-app-region: no-drag;");
    expect(sidebarToggleExclusionRule).toContain("left: var(--codex-window-control-inset);");
    expect(sidebarToggleExclusionRule).toContain("width: var(--codex-toolbar-button-size);");
    expect(memoryDrawerDragTrimRule).toContain("right: min(680px, calc(100vw - 24px));");
    expect(resizeHandleRule).toContain("flex: 0 0 8px;");
    expect(resizeHandleRule).toContain("margin-right: -4px;");
    expect(resizeHandleRule).toContain("margin-left: -4px;");
    expect(resizeHandleRule).toContain("cursor: col-resize;");
    expect(resizeHandleRule).toContain("touch-action: none;");
  });

  it("keeps the active chat conversation header attached above the scroll area", () => {
    const conversationPanelRules = Array.from(globalCss.matchAll(/^\.agent-conversation-panel\s*\{[^}]*\}/gm), (match) => match[0]);
    const conversationPanelFontRule = conversationPanelRules.find((rule) => rule.includes("font-family")) ?? "";
    const messageContentRule = globalCss.match(/^\.agent-message-content\s*\{[^}]*\}/m)?.[0] ?? "";
    const contentTopbarRule = globalCss.match(/^\.app-frame-content-topbar\s*\{[^}]*\}/m)?.[0] ?? "";
    const contentTopbarBorderedRule = globalCss.match(/\.app-frame-content-topbar--bordered\s*\{[^}]*\}/)?.[0] ?? "";
    const conversationTitleRule = globalCss.match(/\.agent-conversation-title\s*\{[^}]*\}/)?.[0] ?? "";
    const conversationScrollRule = globalCss.match(/\.agent-conversation-scroll\s*\{[^}]*\}/)?.[0] ?? "";

    expect(conversationPanelRules.join("\n")).not.toContain("padding-top:");
    expect(conversationPanelFontRule).toContain("font-family: var(--font-sans);");
    // The chat interaction surface (answers, bubbles, activity timeline) uses
    // the dedicated --font-chat pairing so Latin/CJK stay consistent, while
    // the shell around it keeps the Nunito brand font.
    expect(tokenCss).toContain("--font-chat:");
    expect(messageContentRule).toContain("font-family: var(--font-chat);");
    expect(globalCss).toContain(".agent-conversation-panel .agent-chat-bubble,");
    expect(globalCss).toContain(".agent-conversation-panel .agent-activity-cluster,");
    expect(settingsTokenUsageCss).toContain("font-family: var(--font-sans);");
    expect(globalCss).not.toContain("font-family: -apple-system");
    expect(settingsTokenUsageCss).not.toContain("OpenAI Sans");
    expect(contentTopbarRule).toContain("position: absolute;");
    expect(contentTopbarRule).toContain("top: 0;");
    expect(contentTopbarRule).toContain("min-height: var(--codex-toolbar-height);");
    expect(contentTopbarRule).toContain("align-items: center;");
    expect(contentTopbarRule).toContain("overflow: hidden;");
    expect(contentTopbarRule).toContain("padding: 0 var(--codex-content-padding-x);");
    expect(contentTopbarRule).toContain("-webkit-app-region: drag;");
    expect(contentTopbarRule).not.toContain("border-bottom:");
    expect(contentTopbarBorderedRule).toContain("background: transparent");
    expect(contentTopbarBorderedRule).toContain("border-bottom: none");
    expect(globalCss).not.toContain(".agent-conversation-titlebar");
    expect(conversationTitleRule).toContain("flex: 1 1 auto;");
    expect(conversationTitleRule).toContain("font-size: var(--codex-text-base);");
    expect(conversationTitleRule).toContain("font-weight: 500;");
    expect(conversationTitleRule).toContain("line-height: var(--codex-leading-base);");
    expect(conversationTitleRule).toContain("max-width: 100%;");
    expect(conversationTitleRule).toContain("text-overflow: ellipsis;");
    expect(conversationTitleRule).toContain("user-select: none;");
    expect(conversationTitleRule).toContain("white-space: nowrap;");
    expect(conversationScrollRule).toContain("padding-top: 12px;");
    expect(conversationScrollRule).toContain("padding-bottom: 120px;");
    expect(conversationScrollRule).not.toContain("var(--color-action-sky)");
    expect(globalCss).not.toContain(".agent-conversation-scroll::-webkit-scrollbar");
  });

  it("keeps modal utility shims available for connection dialog alignment", () => {
    expect(globalCss).toContain("@keyframes fadeUp");
    expect(globalCss).toContain(".animate-fade-up");
    expect(globalCss).toContain(".shadow-large");
    expect(globalCss).toContain("0 8px 24px -4px rgba(0, 0, 0, 0.1)");
    expect(globalCss).toContain(".max-w-\\[460px\\]");
    expect(globalCss).toContain(".rounded-3xl");
    expect(globalCss).toContain(".line-clamp-2");
    expect(globalCss).toContain(".font-normal");
    expect(globalCss).toContain(".text-sage-700");
    expect(globalCss).toContain(".bg-sage-500");
    expect(globalCss).toContain(".border-coral-200");
    expect(globalCss).toContain(".bg-coral-50");
    expect(globalCss).toContain(".text-coral-700");
  });

  it("keeps the session rename modal backdrop light enough to preserve page context", () => {
    const renameBackdropRule = globalCss.match(/\.rename-dialog-backdrop\s*\{[^}]*\}/)?.[0] ?? "";

    expect(renameBackdropRule).toContain("background: rgba(17, 29, 28, 0.14);");
    expect(renameBackdropRule).toContain("backdrop-filter: blur(2px);");
  });

  it("clamps memory card summaries to two lines", () => {
    const memorySummaryRule = globalCss.match(/\.memory-card__summary\s*\{[^}]*\}/)?.[0] ?? "";

    expect(memorySummaryRule).toContain("overflow: hidden;");
    expect(memorySummaryRule).toContain("-webkit-line-clamp: 2;");
  });

  it("keeps memory drawer IDs selectable inside the window drag area", () => {
    const memoryDrawerBackdropRule = globalCss.match(/\.memory-drawer-backdrop\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryDrawerBackdropCloseRule = globalCss.match(/\.memory-drawer-backdrop__close\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryDrawerRule = globalCss.match(/^\.memory-drawer\s*\{[^}]*\}/m)?.[0] ?? "";
    const memoryDrawerAllRule = globalCss.match(/\.memory-drawer,\s*\.memory-drawer \*\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryDrawerHeaderRule = globalCss.match(/\.memory-drawer__header\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryDrawerIdentityRule = globalCss.match(/\.memory-drawer__identity\s*\{[^}]*\}/)?.[0] ?? "";
    const memoryDrawerEyebrowRule = globalCss.match(/\.memory-drawer__eyebrow\s*\{[^}]*\}/)?.[0] ?? "";

    expect(memoryDrawerBackdropRule).toContain("pointer-events: none;");
    expect(memoryDrawerBackdropRule).toContain("align-items: flex-start;");
    expect(memoryDrawerBackdropRule).not.toContain("-webkit-app-region: no-drag;");
    expect(memoryDrawerBackdropCloseRule).toContain("top: var(--codex-toolbar-height);");
    expect(memoryDrawerBackdropCloseRule).toContain("pointer-events: auto;");
    expect(memoryDrawerBackdropCloseRule).toContain("-webkit-app-region: no-drag;");
    expect(memoryDrawerRule).toContain("pointer-events: auto;");
    expect(memoryDrawerRule).toContain("-webkit-app-region: no-drag;");
    expect(memoryDrawerRule).toContain("height: 100%;");
    expect(memoryDrawerRule).not.toContain("margin-top: var(--codex-toolbar-height);");
    expect(memoryDrawerAllRule).toContain("-webkit-app-region: no-drag;");
    expect(memoryDrawerHeaderRule).toContain("user-select: text;");
    expect(memoryDrawerHeaderRule).toContain("-webkit-user-select: text;");
    expect(memoryDrawerIdentityRule).toContain("display: inline-flex;");
    expect(memoryDrawerIdentityRule).toContain("user-select: text;");
    expect(memoryDrawerIdentityRule).toContain("-webkit-user-select: text;");
    expect(memoryDrawerIdentityRule).toContain("-webkit-app-region: no-drag;");
    expect(memoryDrawerEyebrowRule).toContain("display: inline-block;");
    expect(memoryDrawerEyebrowRule).toContain("cursor: text;");
    expect(memoryDrawerEyebrowRule).toContain("user-select: text;");
    expect(memoryDrawerEyebrowRule).toContain("-webkit-user-select: text;");
    expect(memoryDrawerEyebrowRule).toContain("-webkit-app-region: no-drag;");
    expect(globalCss).not.toContain(".memory-drawer__copy-id");
  });

  it("copies mascot assets into the App source tree instead of referencing the prototype folder", () => {
    const assetNames = [
      "memmy-rice.png",
      "memmy-wave.png",
      "memmy-think.png",
      "memmy-work.png",
      "memmy-celebrate.png",
      "memmy-connect.png",
      "memmy-read.png",
      "memo-idle-alpha.webm",
      "pet-entrance.webp"
    ];

    expect(assetNames.filter((assetName) => !existsSync(resolve(sourceRoot, "assets/mascot", assetName)))).toEqual([]);
  });
});
