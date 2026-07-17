/** App frame tests. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../app/providers.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { enUSMessages, zhCNMessages, type MessageKey } from "../../i18n/messages.js";
import { appActions } from "../../state/app-actions.js";
import { appReducer, createInitialAppState } from "../../state/app-reducer.js";
import type { AgentTaskView } from "../../state/agent-chat-slice.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";
import { AppFrame, TaskArchiveInlineAction, TaskRow, groupAgentTasks, groupTasksByTime, resolveSidebarAccountSummary, resolveSidebarMenuOverlayStyle, shouldCreateNewAgentDraft, truncateAccountDisplayText } from "../app-frame.js";

describe("AppFrame", () => {
  it("使用原型 MainLayout 的侧栏图标与导航文案", () => {
    const html = renderToString(
      <AppProviders>
        <AppFrame title="测试页面">
          <div>工作区</div>
        </AppFrame>
      </AppProviders>
    );

    expect(html).toContain("新任务");
    expect(html).toContain("连接与工具");
    expect(html).toContain("今天");
    expect(html).toContain("暂无任务");
    expect(html).not.toContain("置顶");
    expect(html).not.toContain("归档");
    expect(html).toContain('aria-label="任务列表操作"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="调整主侧边栏宽度"');
    expect(html).toContain("sidebar-resize-handle");
    expect(html).toContain("app-frame-task-section-action__dots");
    expect(html).not.toContain("刷新列表");
    expect(html).not.toContain("预览任务");
    expect(html).not.toContain("排序方式");
    expect(html).not.toContain('title="刷新任务"');
    expect(html).not.toContain('title="切换排序"');
    expect(html).toContain("app-frame-sidebar");
    expect(html).toContain('class="space-y-1.5"');
    expect(html).not.toContain('class="px-2 space-y-1"');
    expect(html).toContain("app-frame-content-topbar");
    expect(html).toContain("relative min-w-0 flex-1 overflow-hidden flex flex-col bg-content-bg");
    expect(html).toContain('data-tour-anchor="product-tour-memory-nav"');
    expect(html).toContain('data-icon="message-square-plus"');
    expect(html).toContain('data-icon="link-2"');
    expect(html).toContain('data-icon="brain-circuit"');
    expect(html).toContain('data-icon="panel-left"');
    expect(html).not.toContain('data-icon="arrow-right"');
    expect(html).toContain("M12 5a3 3 0 1 0-5.997.125");
    expect(html).toContain('data-icon="search"');
    expect(html).not.toContain('data-icon="minimize-2"');
    expect(html).not.toContain("桌宠");
    expect(html).toContain('data-icon="message-circle"');
    expect(html).toContain('data-icon="user"');
    expect(html).toContain('data-icon="settings-2"');
    expect(html).not.toContain('data-icon="settings"');
    expect(html).not.toContain('class="shrink-0 w-5 text-center">M</span>');
    expect(html).not.toContain('class="shrink-0 w-5 text-center">L</span>');
    expect(html).not.toContain(">S</button>");
  });

  it("renders the shared right content top area without a border by default", () => {
    const html = renderToString(
      <AppProviders>
        <AppFrame title="测试页面">
          <div>工作区</div>
        </AppFrame>
      </AppProviders>
    );

    expect(html).toContain("app-frame-content-topbar");
    expect(html).not.toContain("app-frame-content-topbar--bordered");
  });

  it("can omit the shared right content top area for pages with their own split layout", () => {
    const html = renderToString(
      <AppProviders>
        <AppFrame title="测试页面" reserveTopBar={false}>
          <div>工作区</div>
        </AppFrame>
      </AppProviders>
    );

    expect(html).not.toContain("app-frame-content-topbar");
  });

  it("renders an optional bordered right content top area", () => {
    const html = renderToString(
      <AppProviders>
        <AppFrame title="测试页面" topBar={<span>会话标题</span>} topBarBorder>
          <div>工作区</div>
        </AppFrame>
      </AppProviders>
    );

    expect(html).toContain("app-frame-content-topbar app-frame-content-topbar--bordered");
    expect(html).toContain("会话标题");
  });

  it("groups tasks into pinned, active, and archived sections", () => {
    const groups = groupAgentTasks([
      task("normal", { title: "普通任务" }),
      task("pinned", { title: "置顶任务", pinned: true }),
      task("archived", { title: "归档任务", archived: true }),
      task("archived-pinned", { title: "旧置顶归档任务", pinned: true, archived: true })
    ]);

    expect(groups.pinned.map((item) => item.sessionKey)).toEqual(["websocket:pinned"]);
    expect(groups.active.map((item) => item.sessionKey)).toEqual(["websocket:normal"]);
    expect(groups.archived.map((item) => item.sessionKey)).toEqual(["websocket:archived", "websocket:archived-pinned"]);
  });

  it("marks the current sidebar session as selected", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <TaskRow
          task={task("current")}
          isCurrent
          showPreview
          onOpen={() => undefined}
          onContextMenu={() => undefined}
          onPin={() => undefined}
          archiveConfirming={false}
          onRequestArchive={() => undefined}
          onConfirmArchive={() => undefined}
          onUnarchive={() => undefined}
          onDeleteArchived={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('data-current-session="true"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("app-frame-nav-button--active");
    expect(source).toContain("currentSessionKey={highlightedSessionKey}");
    expect(source).toContain("isCurrent={props.currentSessionKey === task.sessionKey}");
    expect(source).toContain('data-current-session={props.isCurrent ? "true" : undefined}');
    expect(source).toContain('aria-current={props.isCurrent ? "page" : undefined}');
    expect(source).toContain('"app-frame-nav-button--active"');
  });

  it("positions the task action menu as a top-level viewport overlay", () => {
    const overlayStyle = resolveSidebarMenuOverlayStyle(
      { right: 188, bottom: 424 },
      { width: 512, height: 768 },
      { width: 128, height: 128, margin: 8, gap: 4 }
    );

    expect(overlayStyle).toEqual({
      right: 324,
      top: 428,
      zIndex: 9999
    });
  });

  it("keeps task action menu labels in the desktop i18n tables", () => {
    const menuKeys: MessageKey[] = [
      "appFrame.taskList.actions",
      "appFrame.task.refresh",
      "appFrame.task.hidePreview",
      "appFrame.task.preview",
      "appFrame.task.sort",
      "appFrame.sort.updatedDesc",
      "appFrame.sort.titleAsc"
    ];

    expect(menuKeys.map((key) => zhCNMessages[key])).toEqual([
      "任务列表操作",
      "刷新列表",
      "隐藏预览",
      "预览任务",
      "排序方式",
      "最近更新",
      "标题排序"
    ]);
    expect(menuKeys.map((key) => enUSMessages[key])).toEqual([
      "Task list actions",
      "Refresh list",
      "Hide preview",
      "Preview tasks",
      "Sort",
      "Recently updated",
      "Sort by title"
    ]);
  });

  it("treats thread 404 as a history-open miss without a sidebar alert", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");
    const removedOpenErrorSetter = "setTaskOpen" + "ErrorKey";
    const removedOpenErrorState = "taskOpen" + "ErrorKey";

    expect(source).toContain('import { MemmyAgentRequestError } from "../api/memmy-agent-client.js";');
    expect(source).toContain("error instanceof MemmyAgentRequestError && error.status === 404");
    expect(source).toContain("dispatch(agentActions.historyOpenMissing(task.sessionKey, chatId, requestId));");
    expect(source).not.toContain("dispatch(agentActions.transientSendFailed(chatId));");
    expect(source).not.toContain(removedOpenErrorSetter);
    expect(source).not.toContain(removedOpenErrorState);
    expect(source).not.toContain('role="alert"');
  });

  it("uses a task-list icon for the preview toggle menu item", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(source).toContain("ListChecks");
    expect(source).toContain('icon={<ListChecks size={12} />} label={props.showPreviews ? t("appFrame.task.hidePreview") : t("appFrame.task.preview")}');
  });

  it("keeps top-level sidebar task menus mutually exclusive", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");
    const toggleTaskListMenuStart = source.indexOf("function toggleTaskListMenu(anchor: SidebarMenuAnchor)");
    const openTaskContextMenuStart = source.indexOf("function openTaskContextMenu");
    const toggleTaskListMenuBlock = source.slice(toggleTaskListMenuStart, openTaskContextMenuStart);
    const openTaskContextMenuBlock = source.slice(openTaskContextMenuStart, source.indexOf("function requestDeleteArchivedTask", openTaskContextMenuStart));

    expect(toggleTaskListMenuBlock).toContain("setTaskContextMenu(null);");
    expect(toggleTaskListMenuBlock).toContain("setArchiveConfirmSessionKey(null);");
    expect(toggleTaskListMenuBlock).toContain("setTaskListMenuAnchor((value) => (value ? null : anchor));");
    expect(toggleTaskListMenuBlock).toContain("setSortMenuOpen(false);");
    expect(openTaskContextMenuBlock).toContain("setTaskListMenuAnchor(null);");
    expect(openTaskContextMenuBlock).toContain("setSortMenuOpen(false);");
    expect(source.match(/toggleTaskListMenu\(sidebarMenuAnchorFromRect/g)).toHaveLength(2);
  });

  it("New Agent opens a local blank draft without calling the backend", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(shouldCreateNewAgentDraft(newAgentDraftState())).toBe(true);
    expect(shouldCreateNewAgentDraft(newAgentDraftState({ blankDraftActive: true }))).toBe(false);
    expect(shouldCreateNewAgentDraft(newAgentDraftState({ composerDraftsByScope: { "draft-3": "未发送" } }))).toBe(false);
    expect(shouldCreateNewAgentDraft(newAgentDraftState({ composerPendingAttachmentsByScope: { "draft-3": [{} as never] } }))).toBe(false);
    expect(source).toContain("function openNewAgent()");
    expect(source).toContain("clearFocusedAgentTarget(");
    expect(source).toContain("if (shouldCreateNewAgentDraft(state.agent))");
    expect(source).toContain("dispatch(agentActions.newChatRequested());");
    expect(source).toContain("dispatch(agentActions.blankDraftReopened());");
    expect(source).toContain('dispatch(appActions.navigate("/main"));');
    expect(source).toContain("openNewAgent();");
    expect(source).not.toContain(".newChat(");
  });

  it("does not expose a temporary first-scan sidebar entry", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(source).not.toContain("openFirstScanFlow");
    expect(source).not.toContain("onboarding.firstScanEntry");
    expect(source).not.toContain("temporary review entry");
  });

  it("shows the improvement plan on the first sidebar interaction (any entry) only for non-BYOK users who have not chosen yet", () => {
    const appFrameSource = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");
    const onboardingSource = readFileSync(resolve(__dirname, "..", "onboarding-page.tsx"), "utf8");

    expect(onboardingSource).toContain("dispatch(appActions.onboardingUpdated(completionPatch));");
    expect(onboardingSource).toContain("dispatch(appActions.navigate(targetRoute));");
    expect(onboardingSource).toContain("void persistReportConversationCompletion(completionPatch)");
    // Handles expect.
    expect(appFrameSource).not.toContain("consumeReportTaskDeferredImprovement");
    expect(appFrameSource).not.toContain("triggerDeferredImprovementProgram");
    expect(appFrameSource).not.toContain("DeferredImprovementPending");
    expect(appFrameSource).toContain("function handleFirstSidebarInteraction()");
    expect(appFrameSource).not.toContain("if (targetPath === state.navigation.currentPath)");
    // App frame tests.
    // Handles expect.
    expect(appFrameSource).toContain('if (deferredGuidanceStep !== "armed")');
    expect(appFrameSource).toContain('state.bootstrap?.app.userMode !== "byok" && state.bootstrap?.onboarding.improvementProgram === "unset" ? "improvement" : "product_tour"');
    expect(appFrameSource).toContain("writeDeferredGuidanceStep(typeof window === \"undefined\" ? undefined : window.sessionStorage, firstStep);");
    expect(appFrameSource).toContain("readDeferredGuidanceStep(typeof window === \"undefined\" ? undefined : window.sessionStorage)");
    expect(appFrameSource).toContain("clearDeferredGuidanceStep(typeof window === \"undefined\" ? undefined : window.sessionStorage)");
    // Handles expect.
    expect(appFrameSource).toContain("handleFirstSidebarInteraction();");
    expect(appFrameSource).toContain('deferredGuidanceStep === "improvement" && state.bootstrap?.app.userMode !== "byok" && state.bootstrap?.onboarding.improvementProgram === "unset"');
    // Handles expect.
    expect(appFrameSource).toContain('writeDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage, "product_tour");');
    expect(appFrameSource).toContain('deferredGuidanceStep === "product_tour"');
    expect(appFrameSource).toContain("<ProductTourGuide");
    expect(appFrameSource).toContain("<ImprovementProgramModal");
    expect(appFrameSource).toContain('openExternalUrl(getLegalLinkUrl("data", language, state.bootstrap?.legal))');
    expect(appFrameSource).toContain("function chooseDeferredImprovementProgram(accepted: boolean)");
    expect(appFrameSource).toContain(".setImprovementProgram(accepted)");
    expect(appFrameSource).not.toContain("setShowGuide(true)");
    // Handles expect.
    expect(appFrameSource).toContain('writeDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage, "nickname");');
    expect(appFrameSource).toContain('deferredGuidanceStep === "nickname"');
    expect(appFrameSource).toContain("<NicknameModal");
    expect(appFrameSource).toContain("function submitDeferredNickname()");
    expect(appFrameSource).toContain("persistNickname({");
    expect(appFrameSource).toContain('isByok: state.bootstrap?.app.userMode === "byok"');
  });

  it("never shows the improvement plan modal in BYOK mode", () => {
    // App frame tests.
    // Definition for app frame source.
    const appFrameSource = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    // Handles expect.
    expect(appFrameSource).toContain('state.bootstrap?.app.userMode !== "byok" && state.bootstrap?.onboarding.improvementProgram === "unset" ? "improvement" : "product_tour"');
    // Handles expect.
    expect(appFrameSource).toContain('deferredGuidanceStep === "improvement" && state.bootstrap?.app.userMode !== "byok" && state.bootstrap?.onboarding.improvementProgram === "unset"');
  });

  it("does not keep New Agent highlighted while a session is current", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(source).toContain('&& (item.path !== "/main" || !state.agent.currentSessionKey)');
  });

  it("makes the whole sidebar account footer open settings", () => {
    const html = renderToString(
      <AppProviders>
        <AppFrame title="测试页面">
          <div>工作区</div>
        </AppFrame>
      </AppProviders>
    );
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(source).toContain("function openSettingsFromSidebar()");
    expect(html).toContain('class="app-frame-sidebar-footer app-frame-sidebar-footer--button"');
    expect(html).toContain('aria-label="设置"');
    expect(html).toContain('data-icon="user"');
    expect(html).toContain('data-icon="settings-2"');
    expect(source).not.toContain('className={`app-frame-profile-settings shrink-0 inline-flex items-center justify-center transition-colors cursor-pointer');
  });

  it("keeps sidebar account settings icon pinned to the footer right edge", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");
    const styles = readFileSync(resolve(__dirname, "..", "..", "styles.css"), "utf8");
    const profileTextRule = styles.match(/\.app-frame-profile-text\s*\{[^}]*\}/)?.[0] ?? "";

    expect(source).toContain('className="flex w-full items-center gap-2 px-2 py-1.5"');
    expect(profileTextRule).toContain("flex: 1 1 auto;");
    expect(profileTextRule).not.toContain("flex: 0 1 146px;");
  });

  it("only highlights a sidebar session on the main route", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(source).toContain('const highlightedSessionKey = state.navigation.currentPath === "/main" ? state.agent.currentSessionKey : null;');
    expect(source).toContain("currentSessionKey={highlightedSessionKey}");
    expect(source).not.toContain("currentSessionKey={state.agent.currentSessionKey}");
  });

  it("deleting an archived main conversation also removes matching pet TaskBus sessions", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(source).toContain('import { useTaskBus } from "../lib/task-bus.js";');
    expect(source).toContain("const taskBus = useTaskBus();");
    expect(source).toContain("taskBus.removeTasksBySessionIds([task.chatId, task.sessionKey]);");
  });

  it("opens a New Agent draft after deleting the current archived conversation", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");
    const handlerStart = source.indexOf("async function confirmDeleteArchivedTask()");
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    const handler = source.slice(handlerStart, source.indexOf("return (", handlerStart));

    expect(handler).toContain("const deletingCurrentTask =");
    expect(handler).toContain("task.sessionKey === state.agent.currentSessionKey");
    expect(handler).toContain("task.chatId === state.agent.currentChatId");
    expect(handler).toContain("await clients.memmyAgent.deleteSession(task.sessionKey);");
    expect(handler).toContain("taskBus.removeTasksBySessionIds([task.chatId, task.sessionKey]);");
    expect(handler).toMatch(/if \(deletingCurrentTask\) \{\s+openNewAgent\(\);\s+\}/);

    const deleteIndex = handler.indexOf("await clients.memmyAgent.deleteSession(task.sessionKey);");
    const openNewAgentIndex = handler.indexOf("if (deletingCurrentTask)");
    const refreshIndex = handler.indexOf("await refreshAgentTasks();");
    expect(deleteIndex).toBeGreaterThan(handler.indexOf("const deletingCurrentTask ="));
    expect(openNewAgentIndex).toBeGreaterThan(deleteIndex);
    expect(refreshIndex).toBeGreaterThan(openNewAgentIndex);
  });

  it("删除侧栏桌宠入口", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(source).not.toContain('t("nav.pet")');
    expect(source).not.toContain("function enterPetMode");
    expect(source).not.toContain("onClick={enterPetMode}");
  });

  it("renames conversations through the session API instead of sidebar title overrides", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");
    const renameBlock = source.slice(source.indexOf("async function renameTask"), source.indexOf("function pinTask"));

    expect(renameBlock).toContain("clients.memmyAgent.renameSession(task.sessionKey, trimmedTitle)");
    expect(renameBlock).toContain("await saveSidebarStateForTask(task, { title: null });");
    expect(renameBlock).toContain("await refreshAgentTasks();");
    expect(renameBlock).not.toContain("{ title: nextTitle }");
  });

  it("collects the new title through an in-app modal instead of window.prompt", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    // Handles expect.
    expect(source).not.toContain("window.prompt");
    expect(source).toContain('import { Modal } from "../components/modal.js";');
    expect(source).toContain("function openRenameDialog(task: AgentTaskView)");
    expect(source).toContain("setRenameTarget(task);");
    expect(source).toContain("onRename={openRenameDialog}");
    expect(source).toContain("open={renameTarget != null}");
    expect(source).toContain('title={t("appFrame.renameTaskPrompt")}');
    expect(source).toContain('backdropClassName="rename-dialog-backdrop"');
    expect(source).toContain("onClick={submitRenameDialog}");
    expect(source).toContain("isComposingKeyboardEvent(event)");
  });

  it("opens the rename modal when a non-archived sidebar session is double-clicked", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(source).toContain("onRenameTask={openRenameDialog}");
    expect(source).toContain("onRename={() => props.onRenameTask(task)}");
    expect(source).toContain("onDoubleClick={(event) => {");
    expect(source).toContain("if (archived || !props.onRename)");
    expect(source).toContain("event.preventDefault();");
    expect(source).toContain("event.stopPropagation();");
    expect(source).toContain("props.onRename();");
  });

  it("syncs main task running state back to pet TaskBus sessions", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(source).toContain("const { syncAgentTaskStatuses } = taskBus;");
    expect(source).toContain("syncAgentTaskStatuses({");
    expect(source).toContain("sessionIds: [task.chatId, task.sessionKey]");
    expect(source).toContain("isRunning: task.runStartedAt != null");
  });

  it("uses the shared confirm dialog for deleting archived conversations", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(source).toContain('import { ConfirmDialog } from "../components/confirm-dialog.js";');
    expect(source).toContain("<ConfirmDialog");
    expect(source).toContain('title={t("appFrame.deleteArchivedTitle")}');
    expect(source).toContain('message={deleteConfirmTask ? t("appFrame.deleteArchivedConfirm"');
    expect(source).toContain('cancelLabel={t("dialog.cancel")}');
    expect(source).toContain('confirmLabel={t("dialog.ok")}');
    expect(source).toContain('confirmVariant="danger"');
    expect(source).not.toContain('iconPose=');
    expect(source).not.toContain('tone="danger"');
    expect(source).not.toContain("window.confirm");
  });

  it("renders the community WeChat QR as a static image instead of a link", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");
    const communityLinksSource = readFileSync(resolve(__dirname, "..", "..", "community", "community-links.ts"), "utf8");
    const githubIndex = source.indexOf('CommunityLink href={communityLinks.githubUrl}');
    const discordIndex = source.indexOf('CommunityLink href={communityLinks.discordUrl}');

    expect(source).toContain('className="community-popover-wechat"');
    expect(source).toContain('<img src={communityLinks.wechatGroupUrl}');
    expect(source).toContain('className="community-link flex flex-col rounded-lg');
    expect(communityLinksSource).toContain('githubUrl: "https://github.com/MemTensor/memmy-agent"');
    expect(source).toContain('detail="MemTensor/memmy-agent"');
    expect(githubIndex).toBeGreaterThan(-1);
    expect(githubIndex).toBeLessThan(discordIndex);
    expect(source).not.toContain('<a href={communityLinks.wechatGroupUrl}');
  });

  it("closes the community popover on outside click and disables sidebar resizing while open", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(source).toContain("const communityMenuRef = useRef<HTMLDivElement | null>(null);");
    expect(source).toContain('document.addEventListener("pointerdown", closeOnOutsidePointerDown);');
    expect(source).toContain("menu.contains(event.target)");
    expect(source).toContain("setShowCommunity(false);");
    expect(source).toContain("isDisabled={sidebarHidden || showCommunity}");
  });

  it("renders archive as an inline confirmation instead of a modal-style action", () => {
    const idleHtml = renderToString(
      <I18nProvider language="zh-CN">
        <TaskArchiveInlineAction
          task={task("normal")}
          confirming={false}
          onPin={() => undefined}
          onRequestArchive={() => undefined}
          onConfirmArchive={() => undefined}
        />
      </I18nProvider>
    );
    const confirmHtml = renderToString(
      <I18nProvider language="zh-CN">
        <TaskArchiveInlineAction
          task={task("normal")}
          confirming
          onPin={() => undefined}
          onRequestArchive={() => undefined}
          onConfirmArchive={() => undefined}
        />
      </I18nProvider>
    );
    const englishIdleHtml = renderToString(
      <I18nProvider language="en-US">
        <TaskArchiveInlineAction
          task={task("normal")}
          confirming={false}
          onPin={() => undefined}
          onRequestArchive={() => undefined}
          onConfirmArchive={() => undefined}
        />
      </I18nProvider>
    );

    expect(idleHtml).toContain('aria-label="置顶对话"');
    expect(idleHtml).not.toContain('title="置顶对话"');
    expect(idleHtml).toContain('aria-label="归档对话"');
    expect(idleHtml).not.toContain('title="归档对话"');
    expect(idleHtml).toContain('aria-describedby="app-tooltip-singleton"');
    expect(englishIdleHtml).toContain('aria-label="Pin conversation"');
    expect(englishIdleHtml).not.toContain('title="Archive conversation"');
    expect(idleHtml).toContain('data-icon="pin"');
    expect(idleHtml).toContain('data-icon="archive"');
    expect(idleHtml).not.toContain("确认");
    expect(confirmHtml).toContain('aria-label="确认归档"');
    expect(confirmHtml).toContain("确认");
    expect(confirmHtml).not.toContain('title="确认归档"');
    expect(confirmHtml).not.toContain('aria-label="归档对话"');
    expect(confirmHtml).not.toContain('data-icon="archive"');
    expect(confirmHtml).not.toContain('data-icon="pin"');
  });

  it("renders current, running, and completed-unseen task row states", () => {
    const runningHtml = renderToString(
      <I18nProvider language="zh-CN">
        <TaskRow
          task={task("running", { runStartedAt: 1780732800 })}
          isCurrent
          showPreview
          onOpen={() => undefined}
          onContextMenu={() => undefined}
          onPin={() => undefined}
          archiveConfirming={false}
          onRequestArchive={() => undefined}
          onConfirmArchive={() => undefined}
          onUnarchive={() => undefined}
          onDeleteArchived={() => undefined}
        />
      </I18nProvider>
    );
    const completedHtml = renderToString(
      <I18nProvider language="zh-CN">
        <TaskRow
          task={task("done", { completedUnseen: true })}
          isCurrent={false}
          showPreview
          onOpen={() => undefined}
          onContextMenu={() => undefined}
          onPin={() => undefined}
          archiveConfirming={false}
          onRequestArchive={() => undefined}
          onConfirmArchive={() => undefined}
          onUnarchive={() => undefined}
          onDeleteArchived={() => undefined}
        />
      </I18nProvider>
    );

    expect(runningHtml).toContain('aria-current="page"');
    expect(runningHtml).toContain("app-frame-nav-button--active");
    expect(runningHtml).toContain('aria-label="正在执行"');
    expect(runningHtml).toContain('data-icon="loader-2"');
    expect(runningHtml).toContain("animate-spin");
    expect(runningHtml).toContain("relative h-6 w-6");
    expect(runningHtml).toContain("absolute inset-0 flex items-center justify-center transition-opacity opacity-100");
    expect(runningHtml).not.toContain('aria-label="归档对话"');
    expect(completedHtml).toContain('aria-label="已完成，打开查看"');
    expect(completedHtml).toContain("--color-warning");
  });

  it("keeps archived task row actions hidden until hover", () => {
    const archivedHtml = renderToString(
      <I18nProvider language="zh-CN">
        <TaskRow
          task={task("archived", { archived: true })}
          isCurrent={false}
          showPreview
          onOpen={() => undefined}
          onContextMenu={() => undefined}
          onPin={() => undefined}
          archiveConfirming={false}
          onRequestArchive={() => undefined}
          onConfirmArchive={() => undefined}
          onUnarchive={() => undefined}
          onDeleteArchived={() => undefined}
        />
      </I18nProvider>
    );
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(archivedHtml).not.toContain('aria-label="删除已归档对话"');
    expect(archivedHtml).not.toContain('title="删除已归档对话"');
    expect(archivedHtml).not.toContain('data-icon="trash-2"');
    expect(source).toContain('label={t("appFrame.task.deleteArchived")} danger onClick={props.onDeleteArchived}');
    expect(source).toContain("<Trash2 size={12} />");
  });

  it("keeps inline task action icons and confirmation text centered", () => {
    const source = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");

    expect(source).toContain("const [isTaskRowHovered, setIsTaskRowHovered] = useState(false);");
    expect(source).toContain("const hasTaskStatus = props.task.runStartedAt != null || props.task.completedUnseen;");
    expect(source).toContain("const shouldShowTaskActions = archived ? isTaskRowHovered : props.archiveConfirming || isTaskRowHovered || hasTaskStatus;");
    expect(source).toContain("app-frame-task-row relative flex items-start gap-1");
    expect(source).toContain("onMouseEnter={() => setIsTaskRowHovered(true)}");
    expect(source).toContain("onMouseLeave={() => setIsTaskRowHovered(false)}");
    expect(source).toContain("flex self-center shrink-0 items-center justify-center gap-0.5 pr-1.5");
    expect(source).toContain("relative h-6 w-6");
    expect(source).toContain("{shouldShowTaskActions && (");
    expect(source).toContain(") : isTaskRowHovered ? (");
    expect(source).toContain("<TaskStatusIndicator task={props.task} />");
    expect(source).toContain('label={t("appFrame.task.archive")}');
    expect(source).not.toContain("group-hover:hidden");
    expect(source).not.toContain("group-hover:block");
    expect(source).not.toContain("pointer-events-none absolute inset-0");
    expect(source).not.toContain("group-hover:pointer-events-auto");
    expect(source).toContain("rounded-input text-center leading-none hover:bg-background-paper/80");
    expect(source).toContain('import { Tooltip } from "../components/tooltip.js";');
    expect(source).toContain("<Tooltip content={props.label}>");
    expect(source).toContain("text-center text-[11px] font-bold leading-none");
  });

  it("keeps task list styling aligned with Codex sidebar typography", () => {
    const appFrameSource = readFileSync(resolve(__dirname, "..", "app-frame.tsx"), "utf8");
    const stylesSource = readFileSync(resolve(__dirname, "..", "..", "styles.css"), "utf8");

    expect(appFrameSource).toContain("app-frame-task-section-header");
    expect(appFrameSource).toContain('className="space-y-1.5"');
    expect(appFrameSource).toContain("text-left pl-3 py-2 cursor-pointer");
    expect(appFrameSource).toContain("app-frame-task-title");
    expect(appFrameSource).toContain("app-frame-task-preview");
    expect(appFrameSource).not.toContain("onToggleCollapsed");
    expect(appFrameSource).not.toContain("opacity-0 transition-opacity group-hover:opacity-100");
    expect(appFrameSource).toContain("hideWhenEmpty");
    expect(stylesSource).toContain(".app-frame-task-section-header");
    expect(stylesSource).toContain(".app-frame-task-title");
    expect(stylesSource).toContain("font-size: 13px;");
    expect(stylesSource).not.toContain(".task-section-header");
    expect(stylesSource).not.toContain(".task-row-actions");
  });

  it("renders task icon tooltips as light fixed overlays", () => {
    const styles = readFileSync(resolve(__dirname, "..", "..", "styles.css"), "utf8");
    const tooltipBlock = styles.slice(styles.indexOf(".app-tooltip {"), styles.indexOf(".app-tooltip--top"));

    expect(tooltipBlock).toContain("position: fixed;");
    expect(tooltipBlock).toContain("z-index: 1000;");
    expect(tooltipBlock).toContain("var(--color-background-paper)");
    expect(tooltipBlock).not.toContain("var(--color-text-ink) 94%");
  });

  it("groups active tasks by time buckets (today, yesterday, last 7 days, older)", () => {
    const now = new Date("2026-07-02T14:00:00+08:00");
    const groups = groupTasksByTime([
      task("today-1", { title: "今天的任务", updatedAt: "2026-07-02T10:00:00+08:00" }),
      task("today-2", { title: "今天的另一个", updatedAt: "2026-07-02T01:00:00+08:00" }),
      task("yesterday", { title: "昨天的任务", updatedAt: "2026-07-01T18:00:00+08:00" }),
      task("week", { title: "三天前", updatedAt: "2026-06-29T12:00:00+08:00" }),
      task("older", { title: "很久以前", updatedAt: "2026-06-20T12:00:00+08:00" }),
      task("no-date", { title: "无日期", updatedAt: null })
    ], now);

    expect(groups.map((g) => g.labelKey)).toEqual([
      "appFrame.timeGroup.today",
      "appFrame.timeGroup.yesterday",
      "appFrame.timeGroup.last7days",
      "appFrame.timeGroup.older"
    ]);
    expect(groups[0]!.tasks.map((t) => t.chatId)).toEqual(["today-1", "today-2"]);
    expect(groups[1]!.tasks.map((t) => t.chatId)).toEqual(["yesterday"]);
    expect(groups[2]!.tasks.map((t) => t.chatId)).toEqual(["week"]);
    expect(groups[3]!.tasks.map((t) => t.chatId)).toEqual(["older", "no-date"]);
  });

  it("returns empty array when no active tasks exist", () => {
    expect(groupTasksByTime([])).toEqual([]);
  });

  it("uses app userMode as the sidebar account source of truth", () => {
    const accountState = appReducer(
      appReducer(createInitialAppState(), appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, userMode: "account" } }, "/settings")),
      appActions.accountUpdated({ nickname: "", email: "" })
    );
    const byokState = appReducer(
      appReducer(createInitialAppState(), appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, userMode: "byok" } }, "/settings")),
      appActions.accountUpdated({ nickname: "" })
    );

    expect(resolveSidebarAccountSummary(accountState, sidebarLabels())).toEqual({
      name: "未登录",
      meta: "未绑定手机号或邮箱"
    });
    // Handles expect.
    expect(resolveSidebarAccountSummary(byokState, sidebarLabels())).toEqual({
      name: "Memmy",
      meta: "API Key 模式"
    });
  });

  it("shows the persisted local nickname in BYOK sidebar account mode", () => {
    // App frame tests.
    // Definition for byok named state.
    const byokNamedState = appReducer(
      appReducer(createInitialAppState(), appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, userMode: "byok" } }, "/settings")),
      appActions.accountUpdated({ nickname: "悠然麦穗" })
    );

    expect(resolveSidebarAccountSummary(byokNamedState, sidebarLabels())).toEqual({
      name: "悠然麦穗",
      meta: "API Key 模式"
    });
  });

  it("shows phone or email in sidebar account mode", () => {
    const phoneState = appReducer(
      appReducer(createInitialAppState(), appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, userMode: "account" } }, "/settings")),
      appActions.accountUpdated({ nickname: "", email: "", phoneNumber: "13800138000" })
    );
    const emailState = appReducer(
      appReducer(createInitialAppState(), appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, userMode: "account" } }, "/settings")),
      appActions.accountUpdated({ nickname: "", email: "grace@example.com", phoneNumber: null })
    );

    expect(resolveSidebarAccountSummary(phoneState, sidebarLabels())).toEqual({
      name: "138****8000",
      meta: "138****8000"
    });
    expect(resolveSidebarAccountSummary(emailState, sidebarLabels())).toEqual({
      name: "g***@example.com",
      meta: "g***@example.com"
    });
  });

  it("truncates account display text by visual character width", () => {
    expect(truncateAccountDisplayText("悠然麦穗春日记忆助手版", 10)).toEqual({
      text: "悠然麦穗春日记忆助手…",
      truncated: true
    });
    expect(truncateAccountDisplayText("abcdefghijklmnopqrstu", 10)).toEqual({
      text: "abcdefghijklmnopqrst…",
      truncated: true
    });
    expect(truncateAccountDisplayText("Grace用户123", 5)).toEqual({
      text: "Grace用户1…",
      truncated: true
    });
    expect(truncateAccountDisplayText("悠然麦穗", 10)).toEqual({
      text: "悠然麦穗",
      truncated: false
    });
  });
});

/** Handles sidebar labels. */
function sidebarLabels() {
  return {
    brandName: "Memmy",
    byokLabel: "API Key 模式",
    accountFallback: "未登录",
    accountMetaFallback: "未绑定手机号或邮箱",
    unsetName: "未选择模式",
    unsetMeta: "重新选择登录方式"
  };
}

function task(chatId: string, overrides: Partial<ReturnType<typeof baseTask>> = {}) {
  return { ...baseTask(chatId), ...overrides };
}

function baseTask(chatId: string): AgentTaskView {
  return {
    sessionKey: `websocket:${chatId}`,
    chatId,
    title: chatId,
    preview: "",
    updatedAt: null,
    runStartedAt: null,
    completedUnseen: false,
    pinned: false,
    archived: false,
    tags: []
  };
}

type NewAgentDraftTestState = Parameters<typeof shouldCreateNewAgentDraft>[0];

function newAgentDraftState(overrides: Partial<NewAgentDraftTestState> = {}): NewAgentDraftTestState {
  return {
    blankDraftActive: false,
    newChatRequestId: 3,
    composerDraftsByScope: {},
    composerPendingAttachmentsByScope: {},
    composerMediaErrorByScope: {},
    ...overrides
  };
}
