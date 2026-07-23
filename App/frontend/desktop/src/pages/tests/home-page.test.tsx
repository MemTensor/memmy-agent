/** Home page tests. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MemmyAgentRequestError } from "../../api/memmy-agent-client.js";
import { AgentRuntimeBridge } from "../../app/agent-runtime-bridge.js";
import { AppProviders } from "../../app/providers.js";
import { FOCUSED_AGENT_CHAT_STORAGE_KEY } from "../../app/routes.js";
import type { SlashCommandStorageLike } from "../agent-command-palette.js";
import { buildAgentDisplayUnits } from "../agent-thread-messages.js";
import {
  AGENT_RESTART_STATE_STORAGE_KEY,
  AGENT_MEDIA_ACCEPT,
  ComposerMediaPreviewStrip,
  ComposerSubmitButton,
  HomePage,
  agentErrorText,
  agentStatusText,
  agentChatScopeKey,
  attachmentFilesFromDataTransfer,
  clipboardImageFilesFromDataTransfer,
  dataTransferHasAttachmentFiles,
  hasActiveAgentConversation,
  hydrateAgentThreadInBackground,
  isAgentConversationAtBottom,
  isComposingKeyboardEvent,
  isSingleLineComposerInput,
  parseStoredAgentRestartState,
  readFocusedAgentChatId,
  requestNewSessionReset,
  requestAgentRestart,
  requestAgentStop,
  shouldAcceptAgentStatusResult,
  submitAgentComposerMessage,
  updateComposerDraftForScope,
  fileToPendingAttachment,
  validateAgentMediaFiles,
  type PendingFileAttachment
} from "../home-page.js";

const homePageSourcePath = fileURLToPath(new URL("../home-page.tsx", import.meta.url));
const agentRuntimeBridgeSourcePath = fileURLToPath(new URL("../../app/agent-runtime-bridge.tsx", import.meta.url));
const stylesSourcePath = fileURLToPath(new URL("../../styles.css", import.meta.url));

function readAgentRuntimeBridgeSource(): string {
  return readFileSync(agentRuntimeBridgeSourcePath, "utf8").replace(/\r\n/g, "\n");
}

function mockCallOrder(fn: { mock: { invocationCallOrder: readonly number[] } }, index = 0): number {
  const value = fn.mock.invocationCallOrder[index];
  if (typeof value !== "number") {
    throw new Error(`Expected mock call order at index ${index}`);
  }
  return value;
}

describe("HomePage", () => {
  it("renders the first-phase agent input controls", () => {
    const html = renderToString(
      <AppProviders>
        <AgentRuntimeBridge>
          <HomePage />
        </AgentRuntimeBridge>
      </AppProviders>
    );

    expect(html).toContain("分配一个任务或提问任何问题...");
    expect(html).toContain("添加图片和文件");
    expect(html).toContain("语音输入");
    expect(html).toContain("发送");
    expect(html).toContain("Agent 正在连接");
    expect(html).not.toContain('aria-haspopup="menu"');
    expect(html).not.toContain('aria-expanded=');
    expect(html).toContain(`accept="${AGENT_MEDIA_ACCEPT}"`);
    expect(html).toContain("hidden");
    expect(html).toContain('class="hidden"');
    expect(html).toContain('data-icon="plus"');
    expect(html).toContain('data-icon="mic"');
    expect(html).toContain('data-icon="send"');
    expect(html).not.toContain("添加照片和文件");
    expect(html).not.toContain("停止");
    expect(html).not.toContain('data-icon="image-plus"');
    expect(html).not.toContain('data-icon="pause"');
    expect(html).toContain("内容由 AI 生成，请仔细甄别");
    expect(html).toContain("text-center text-[11px] text-text-ink/40 mt-4");
    expect(html).toContain("试试这些任务");
    expect(html).toContain("点击后可先修改，再发送");
    expect(html).toContain("回顾最近任务");
    expect(html).toContain("总结工作偏好");
    expect(html).toContain("规划今日重点");
    expect(html).toContain("读懂图片或文件");
    expect(html.match(/class="home-starter-prompt"/g)).toHaveLength(4);
    expect(html).not.toContain("未选择任何文件");
  });

  it("hides the agent status line after the websocket is connected", () => {
    expect(agentStatusText("connected", "agent_chat", (key, values) => `${key}:${values?.model ?? ""}`)).toBeNull();
    expect(agentStatusText("connecting", null, (key) => key)).toBe("home.agent.connecting");
    expect(agentStatusText("reconnecting", null, (key) => key)).toBe("home.agent.reconnecting");
    expect(agentStatusText("error", null, (key) => key)).toBe("home.agent.failed");
  });

  it("recovers slash commands after the initial command snapshot fails", () => {
    const source = readFileSync(homePageSourcePath, "utf8");
    const loadSlashCommandsBlock = source.slice(
      source.indexOf("const loadSlashCommands = useCallback"),
      source.indexOf("  useEffect(() => {\n    if (!clients?.memmyAgent)")
    );
    const updateComposerInputBlock = source.slice(
      source.indexOf("function updateComposerInput(value: string)"),
      source.indexOf("  /**\n   * 自动收缩或展开输入框高度。")
    );

    expect(source).not.toContain("SlashCommandsLoadStatus");
    expect(source).not.toContain("slashCommandsLoadStatusRef");
    expect(source).toContain("const SLASH_COMMAND_RETRY_DELAYS_MS = [300, 1000, 2500];");
    expect(source).toContain("const slashCommandsInFlightRef = useRef(false);");
    expect(source).toContain("const slashCommandsRequestIdRef = useRef(0);");
    expect(source).toContain("const slashCommandsRetryTimerRef = useRef<number | null>(null);");
    expect(source).not.toContain("setSlashCommands([])");
    expect(loadSlashCommandsBlock).toContain("if (slashCommandsInFlightRef.current)");
    expect(loadSlashCommandsBlock).toContain("slashCommandsRequestIdRef.current += 1;");
    expect(loadSlashCommandsBlock).toContain("if (requestId !== slashCommandsRequestIdRef.current)");
    expect(loadSlashCommandsBlock).toContain("window.setTimeout");
    expect(source).toContain("window.clearTimeout(slashCommandsRetryTimerRef.current);");
    expect(updateComposerInputBlock).toContain("slashQueryFromInput(value) != null");
    expect(updateComposerInputBlock).toContain("slashCommandsRef.current.length === 0");
    expect(updateComposerInputBlock).toContain("!slashCommandsInFlightRef.current");
    expect(updateComposerInputBlock).toContain("loadSlashCommands({ resetAttempts: true });");
  });

  it("keeps slash menu rendering and command panels on their existing boundaries", () => {
    const source = readFileSync(homePageSourcePath, "utf8");

    expect(source).toContain("const slashMenuOpen = filteredSlashCommands.length > 0;");
    expect(source.match(/\{slashMenuOpen && \(/g)).toHaveLength(2);
    expect(source).toContain("const [lastCompactionPanel, setLastCompactionPanel] = useState<StatusPanelState>({ open: false });");
    expect(source).toContain("const lastCompactionSlashCommand: SlashCommandPaletteItem = {");
    expect(source).toContain('command: "/last-compaction"');
    expect(source).toContain("const slashCommandsWithLocal = [");
    expect(source).toContain('...localizedSlashCommands.filter((command) => command.command !== "/last-compaction")');
    expect(source).toContain("buildVisibleSlashCommands(slashCommandsWithLocal, state.agent.isSending, stopSlashCommand)");
    expect(source).toContain("{statusPanel.open && !slashMenuOpen && (");
    expect(source).toContain("{lastCompactionPanel.open && !slashMenuOpen && (");
    expect(source).toContain("{lastCompactionPanel.open && !statusPanel.open && !slashMenuOpen && (");
    expect(source).toContain("{historyDagPanel.open && !statusPanel.open && !lastCompactionPanel.open && !slashMenuOpen && (");
    expect(source).toContain("requestNewSessionReset({");
    expect(source).toContain("ensureChatSubscription,");
    expect(source).toContain('content: "/new"');
  });

  it("keeps the active conversation using shared container spacing hooks", () => {
    const source = readFileSync(homePageSourcePath, "utf8");

    expect(source).toContain('className="agent-conversation-panel flex flex-col h-full"');
    expect(source).toContain("const activeConversationTitle = state.agent.currentSessionKey");
    expect(source).toContain("const activeConversationTitleDisplay = formatConversationTitleForDisplay(activeConversationTitle);");
    expect(source).toContain("topBar={hasActiveConversation ? (");
    expect(source).toContain('<h1 className="agent-conversation-title" title={activeConversationTitle}>');
    expect(source).toContain("{activeConversationTitleDisplay}");
    expect(source).toContain("topBarBorder={hasActiveConversation}");
    expect(source).not.toContain("agent-conversation-titlebar");
    expect(source).toContain("app-frame-page-content agent-conversation-scroll flex-1 overflow-y-auto");
    expect(source).toContain("onScroll={handleAgentConversationScroll}");
    expect(source).toContain('className="agent-conversation-composer"');
  });

  it("anchors the history DAG popover to the composer width", () => {
    const source = readFileSync(homePageSourcePath, "utf8");

    expect(source).toContain("{historyDagPanel.open && !statusPanel.open && !lastCompactionPanel.open && !slashMenuOpen && (");
    expect(source).toContain('className="absolute left-0 right-0 bottom-full mb-3 z-30 w-full"');
    expect(source).not.toContain('className="absolute left-1/2 bottom-full mb-3 z-30 -translate-x-1/2"');
  });

  it("auto-dismisses the visible agent error after five seconds", () => {
    const source = readFileSync(homePageSourcePath, "utf8");

    expect(source).toContain("AGENT_ERROR_AUTO_DISMISS_MS = 5000");
    expect(source).toContain("COMPOSER_ERROR_AUTO_DISMISS_MS = 5000");
    expect(source).toContain("window.setTimeout");
    expect(source).toContain("agentActions.errorDismissed(currentError)");
    expect(source).toContain("agentActions.composerMediaErrorUpdated(chatScopeKey, null)");
    expect(source).toContain("window.clearTimeout");
  });

  it("keeps composer state in the agent reducer instead of HomePage local state", () => {
    const source = readFileSync(homePageSourcePath, "utf8");

    expect(source).toContain("state.agent.composerDraftsByScope");
    expect(source).toContain("state.agent.composerPendingAttachmentsByScope");
    expect(source).toContain("state.agent.composerMediaErrorByScope");
    expect(source).toContain("agentActions.composerDraftUpdated(scopeKey, nextValue)");
    expect(source).toContain("const sendScopeKey = chatScopeKey;");
    expect(source).toContain("clearComposer: () => clearComposerAfterSend(sendScopeKey)");
    expect(source).not.toContain("useState<Record<string, string>>({})");
    expect(source).not.toContain("useState<Record<string, PendingAttachment[]>>({})");
    expect(source).not.toContain("useState<Record<string, string | null>>({})");
  });

  it("does not revoke all pending attachments when HomePage unmounts", () => {
    const source = readFileSync(homePageSourcePath, "utf8");

    expect(source).toContain("agentActions.composerScopeCleared(scopeKey)");
    expect(source).not.toContain("Object.values(pendingAttachmentsRef.current)");
  });

  it("does not treat a remounted HomePage as a fresh New Agent request", () => {
    const source = readFileSync(homePageSourcePath, "utf8");

    expect(source).toContain("const lastNewChatRequestRef = useRef(state.agent.newChatRequestId);");
    expect(source).not.toContain("const lastNewChatRequestRef = useRef(0);");
  });

  it("consumes launch chat query params when reading focused agent chat ids", () => {
    const storage = new MemoryStorage();
    const replaceState = vi.fn();
    storage.setItem(FOCUSED_AGENT_CHAT_STORAGE_KEY, "stored-chat");

    const chatId = readFocusedAgentChatId(
      "?foo=1&memmyAgentChat=launch-chat",
      storage,
      { href: "https://memmy.local/main?foo=1&memmyAgentChat=launch-chat#thread" },
      { state: { from: "test" }, replaceState }
    );

    expect(chatId).toBe("launch-chat");
    expect(storage.getItem(FOCUSED_AGENT_CHAT_STORAGE_KEY)).toBeNull();
    expect(replaceState).toHaveBeenCalledWith({ from: "test" }, "", "/main?foo=1#thread");
  });

  it("passes the current UI language into agent websocket messages", () => {
    const source = readFileSync(homePageSourcePath, "utf8");
    const sendBlock = source.slice(source.indexOf("async function sendMessage()"), source.indexOf("  /**\n   * 停止当前 Agent 回合"));

    expect(source).toContain("const { language, t } = useTranslation();");
    expect(sendBlock).toContain("language,");
  });

  it("intercepts exact local slash commands before normal message submission", () => {
    const source = readFileSync(homePageSourcePath, "utf8");
    const sendBlock = source.slice(source.indexOf("async function sendMessage()"), source.indexOf("  /**\n   * 停止当前 Agent 回合"));
    const localSlashBlock = source.slice(source.indexOf("function runExactLocalSlashCommand"), source.indexOf("  /**\n   * 停止当前 Agent 回合"));

    expect(sendBlock).toContain("if (runExactLocalSlashCommand(input))");
    expect(sendBlock.indexOf("runExactLocalSlashCommand(input)")).toBeLessThan(sendBlock.indexOf("submitAgentComposerMessage({"));
    expect(localSlashBlock).toContain("if (pendingAttachments.length > 0) return false;");
    expect(localSlashBlock).toContain('normalized === "/last-compaction"');
    expect(localSlashBlock).toContain("requestLastCompactionPanel();");
    expect(localSlashBlock).toContain('normalized === "/history-dag"');
    expect(localSlashBlock).toContain("requestHistoryDagPanel();");
    expect(localSlashBlock).toContain('normalized === "/status"');
    expect(localSlashBlock).toContain("requestStatusPanel();");
  });

  it("keeps last-compaction as a local composer panel backed by the session HTTP snapshot", () => {
    const source = readFileSync(homePageSourcePath, "utf8");
    const requestBlock = source.slice(source.indexOf("function requestLastCompactionPanel()"), source.indexOf("  /**\n   * Requests and opens the current conversation's history DAG panel."));
    const selectBlock = source.slice(source.indexOf("function selectSlashCommand"), source.indexOf("  /**\n   * Handles keyboard interaction"));

    expect(source).toContain("const pendingLastCompactionChatRef = useRef<string | null>(null);");
    expect(source).toContain("const lastCompactionRequestIdRef = useRef(0);");
    expect(requestBlock).toContain("setStatusPanel({ open: false });");
    expect(requestBlock).toContain("setHistoryDagPanel({ open: false });");
    expect(requestBlock).toContain("state.agent.currentSessionKey ?? client.chatIdToSessionKey(chatId)");
    expect(requestBlock).toContain("client.readLastCompaction(sessionKey)");
    expect(requestBlock).toContain("requestId !== lastCompactionRequestIdRef.current");
    expect(requestBlock).toContain("pendingLastCompactionChatRef.current !== chatId");
    expect(requestBlock).toContain('payload.available ? payload.text : t("home.lastCompaction.noSummary")');
    expect(selectBlock).toContain('command.command === "/last-compaction"');
    expect(selectBlock).toContain("requestLastCompactionPanel();");
    expect(source).not.toContain('content: "/last-compaction"');
  });

  it("keeps ASR errors local to the composer instead of marking the agent connection failed", () => {
    const source = readFileSync(homePageSourcePath, "utf8");
    const startVoiceInputStart = source.indexOf("function startVoiceInput()");
    const finishVoiceInputStart = source.indexOf("async function finishVoiceInput()");
    const toggleVoiceInputStart = source.indexOf("function toggleVoiceInput()");
    const startVoiceInput = source.slice(startVoiceInputStart, finishVoiceInputStart);
    const finishVoiceInput = source.slice(finishVoiceInputStart, toggleVoiceInputStart);

    expect(startVoiceInput).toContain("setCurrentComposerMediaError(toReadableAsrError(error, t))");
    expect(finishVoiceInput).toContain("setCurrentComposerMediaError(toReadableAsrError(error, t))");
    expect(startVoiceInput).not.toContain("agentActions.failed");
    expect(finishVoiceInput).not.toContain("agentActions.failed");
  });

  it("uses the send button disabled state when handling Enter submit", () => {
    const source = readFileSync(homePageSourcePath, "utf8");
    const keyDownHandler = source.slice(source.indexOf("function handleComposerKeyDown"), source.indexOf("  /**\n   * 校验并暂存用户选择"));

    expect(keyDownHandler).toContain("!composerSubmitDisabled");
    expect(keyDownHandler).not.toContain("!state.agent.isSending && !isCreatingChat");
  });

  it("derives chat scope and active conversation from current chat identity", () => {
    expect(agentChatScopeKey("chat-1", 3)).toBe("chat-1");
    expect(agentChatScopeKey(null, 3)).toBe("draft-3");
    expect(hasActiveAgentConversation("chat-1", 1)).toBe(true);
    expect(hasActiveAgentConversation("chat-1", 0)).toBe(false);
    expect(hasActiveAgentConversation(null, 1)).toBe(false);
  });

  it("keeps composer drafts isolated by chat scope", () => {
    let drafts: Record<string, string> = {};
    drafts = updateComposerDraftForScope(drafts, "chat-a", "A 的草稿");
    drafts = updateComposerDraftForScope(drafts, "chat-b", "B 的草稿");
    drafts = updateComposerDraftForScope(drafts, "chat-a", (current) => `${current} plus`);

    expect(drafts).toEqual({
      "chat-a": "A 的草稿 plus",
      "chat-b": "B 的草稿"
    });

    drafts = updateComposerDraftForScope(drafts, "chat-a", "");
    expect(drafts).toEqual({ "chat-b": "B 的草稿" });
  });

  it("detects IME composing Enter and Tab events", () => {
    expect(isComposingKeyboardEvent({ nativeEvent: { isComposing: true } } as any)).toBe(true);
    expect(isComposingKeyboardEvent({ nativeEvent: { keyCode: 229 } } as any)).toBe(true);
    expect(isComposingKeyboardEvent({ nativeEvent: { isComposing: false, keyCode: 13 } } as any)).toBe(false);
  });

  it("centers the composer controls only while the session composer is one line", () => {
    const source = readFileSync(homePageSourcePath, "utf8");

    expect(source).toContain('${isComposerSingleLine ? "agent-composer-input--single " : ""}block w-full pl-4 pr-20 py-3 text-sm resize-none focus:outline-none rounded-card-lg bg-background-paper placeholder:text-text-ink/40');
    expect(source).toContain('centerComposerControls ? "top-1/2 -translate-y-1/2" : "bottom-2"');
    expect(source).toContain("COMPOSER_SINGLE_LINE_HEIGHT_PX = 52");
  });

  it("keeps the single-line composer text and caret vertically centered", () => {
    const window = new Window();
    const style = window.document.createElement("style");
    style.textContent = readFileSync(stylesSourcePath, "utf8").replace(/^@import[^;]+;$/gm, "");
    window.document.head.append(style);

    const shell = window.document.createElement("div");
    shell.className = "agent-composer-shell";
    const textarea = window.document.createElement("textarea");
    textarea.className = "agent-composer-input--single py-3 text-sm";
    shell.append(textarea);
    window.document.body.append(shell);

    const computed = window.getComputedStyle(textarea);
    expect(computed.height).toBe("52px");
    expect(computed.lineHeight).toBe("24px");
    expect(computed.paddingTop).toBe("14px");
    expect(computed.paddingBottom).toBe("14px");
  });

  it("applies the composer single-line treatment only while the textarea is one line", () => {
    vi.stubGlobal("window", {
      getComputedStyle: () => ({
        lineHeight: "24px",
        paddingTop: "12px",
        paddingBottom: "12px"
      })
    });

    const element = { clientHeight: 48, scrollHeight: 48 } as HTMLTextAreaElement;
    expect(isSingleLineComposerInput(element)).toBe(true);

    Object.defineProperty(element, "scrollHeight", { value: 76 });
    expect(isSingleLineComposerInput(element)).toBe(false);

    vi.unstubAllGlobals();
  });

  it("keeps auto-scroll pinned only while the conversation is near the bottom", () => {
    expect(isAgentConversationAtBottom({ scrollTop: 398, clientHeight: 600, scrollHeight: 1000 })).toBe(true);
    expect(isAgentConversationAtBottom({ scrollTop: 300, clientHeight: 600, scrollHeight: 1000 })).toBe(false);
  });

  it("完整模式当前会话消息会同步回桌宠 TaskBus", () => {
    const source = readFileSync(homePageSourcePath, "utf8");

    expect(source).toContain('import { useTaskBus, type TaskBusAgentMessage } from "../lib/task-bus.js";');
    expect(source).toContain("const { syncAgentConversation } = useTaskBus();");
    expect(source).toContain("syncAgentConversation({");
    expect(source).toContain("sessionIds,");
    expect(source).toContain("createdAt: message.createdAt");
    expect(source).toContain("isRunning: isCurrentAgentRunning");
  });

  it("同步桌宠任务运行态时不依赖消息残留 streaming 标记", () => {
    const source = readFileSync(homePageSourcePath, "utf8");
    const isRunningBlock = source.slice(source.indexOf("const isCurrentAgentRunning"), source.indexOf("  useEffect(() => {", source.indexOf("const isCurrentAgentRunning")));

    expect(isRunningBlock).toContain("state.agent.isSending");
    expect(isRunningBlock).toContain("state.agent.runStartedAtByChatId[state.agent.currentChatId]");
    expect(isRunningBlock).toContain("state.agent.optimisticSendingByChatId[state.agent.currentChatId]");
    expect(isRunningBlock).not.toContain("message.isStreaming");
    expect(isRunningBlock).not.toContain("message.reasoningStreaming");
  });

  it("passes current chat sending state into thread activity rendering", () => {
    const source = readFileSync(homePageSourcePath, "utf8");
    const threadBlock = source.slice(source.indexOf("<AgentThreadMessages"), source.indexOf("/>", source.indexOf("<AgentThreadMessages")) + 2);

    expect(threadBlock).toContain("messages={state.agent.messages}");
    expect(threadBlock).toContain("isSending={state.agent.isSending}");
  });

  it("only enables friendly platform API error fallback in account mode", () => {
    const source = readFileSync(homePageSourcePath, "utf8");
    const threadBlock = source.slice(source.indexOf("<AgentThreadMessages"), source.indexOf("/>", source.indexOf("<AgentThreadMessages")) + 2);

    expect(source).toContain('const isAccountMode = state.bootstrap?.app.userMode === "account";');
    expect(source).toContain("const sanitizePlatformApiErrors = isAccountMode;");
    expect(threadBlock).toContain("sanitizePlatformApiErrors={sanitizePlatformApiErrors}");
    expect(threadBlock).toContain("accountMode={isAccountMode}");
  });

  it("keeps background run lifecycle events intact for reducer completion semantics", () => {
    const source = readAgentRuntimeBridgeSource();
    const subscriptionBlock = source.slice(source.indexOf("connectionUnsubscribersRef.current = ["), source.indexOf("useEffect(() => {\n    const chatId = state.agent.currentChatId;"));

    expect(subscriptionBlock).toContain("nextConnection.onRunLifecycle((chatId, event) => {");
    expect(subscriptionBlock).toContain("if (chatId === subscribedChatRef.current)");
    expect(subscriptionBlock).toContain("dispatch(agentActions.wsEventReceived(event));");
    expect(subscriptionBlock).not.toContain("nextConnection.onRunStatus");
    expect(subscriptionBlock).not.toContain('event: "goal_status"');
  });

  it("consumes the shared AgentRuntimeBridge connection instead of owning websocket lifecycle", () => {
    const source = readFileSync(homePageSourcePath, "utf8");

    expect(source).toContain("const { connection, ensureChatSubscription } = useAgentRuntimeBridge();");
    expect(source).toContain("connection.onStatusResult((chatId, content) => {");
    expect(source).toContain("subscribedChatId: state.agent.currentChatId");
    expect(source).not.toContain("connectWebSocket(");
    expect(source).not.toContain("connectionRef.current?.close()");
    expect(source).not.toContain("const subscribeAgentChat = useCallback");
  });

  it("guards duplicate stop requests while a stop control frame is in flight", () => {
    const source = readFileSync(homePageSourcePath, "utf8");
    const normalizedSource = source.replace(/\r\n/g, "\n");
    const submitDisabledBlock = normalizedSource.slice(
      normalizedSource.indexOf("const composerSubmitDisabled"),
      normalizedSource.indexOf("const centerComposerControls")
    );

    expect(source).toContain("const stopInFlight = state.agent.currentChatId ? Boolean(state.agent.stopInFlightByChatId[state.agent.currentChatId]) : false;");
    expect(source).toContain("const stopRequestLocksRef = useRef<Set<string>>(new Set());");
    expect(source).toContain("input.stopRequestLocks.has(chatId)");
    expect(submitDisabledBlock).toContain("isCurrentAgentRunning\n    ? stopInFlight");
  });

  it("locks duplicate stop clicks before React state re-renders", () => {
    const stop = vi.fn();
    const dispatch = vi.fn();
    const track = vi.fn();
    const stopRequestLocks = new Set<string>();
    const input = {
      chatId: "chat-1",
      connection: { stop },
      stopInFlightByChatId: {},
      stopRequestLocks,
      dispatch,
      track
    };

    expect(requestAgentStop(input)).toBe(true);
    expect(requestAgentStop(input)).toBe(false);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("chat-1");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "agent/stopRequested", chatId: "chat-1" });
    expect(track).toHaveBeenCalledTimes(1);
    expect(stopRequestLocks.has("chat-1")).toBe(true);
  });

  it("returns false without locking when there is no active connection", () => {
    const dispatch = vi.fn();
    const track = vi.fn();
    const stopRequestLocks = new Set<string>();
    const input = {
      chatId: "chat-1",
      connection: null,
      stopInFlightByChatId: {},
      stopRequestLocks,
      dispatch,
      track
    };

    expect(requestAgentStop(input)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    expect(stopRequestLocks.has("chat-1")).toBe(false);
  });

  it("refresh effect uses background hydrate instead of foreground history loading", () => {
    const source = readAgentRuntimeBridgeSource();

    expect(source).toContain("state.agent.currentHistoryHydrateRequestIdByChatId[chatId]");
    expect(source).toContain("hydrateAgentThreadInBackground(clients.memmyAgent, dispatch, chatId);");
    expect(source).toContain("if (!state.agent.isLoadingSessions) {");
    expect(source).not.toContain("pendingCanonicalHydrateByChatId[chatId]) {\n        loadAgentThread");
  });

  it("metadata-only task refresh reads sessions and sidebar state without hydrating messages", () => {
    const source = readAgentRuntimeBridgeSource();
    const refreshEffect = source.slice(source.indexOf("useEffect(() => {\n    if (!clients?.memmyAgent || !state.agent.refreshRequested || !enabled)"), source.indexOf("  }, [\n    clients?.memmyAgent,\n    dispatch,\n    enabled"));
    const refreshTaskList = source.slice(source.indexOf("export function refreshAgentTaskList"), source.indexOf("function isAgentConnectionEvent"));

    expect(refreshEffect).toContain("Object.entries(state.agent.pendingCanonicalHydrateByChatId)");
    expect(refreshEffect).toContain("hydrateAgentThreadInBackground(clients.memmyAgent, dispatch, chatId);");
    expect(refreshEffect).toContain("void refreshAgentTaskList(clients.memmyAgent, dispatch);");
    expect(refreshTaskList).toContain("client.listSessions()");
    expect(refreshTaskList).toContain("client.readSidebarState()");
    expect(refreshTaskList).not.toContain("readWebuiThread");
  });

  it("hydrates agent threads in the background without foreground history actions", async () => {
    const dispatch = vi.fn();
    const client = {
      chatIdToSessionKey: (chatId: string) => `websocket:${chatId}`,
      readWebuiThread: vi.fn(async () => ({
        schemaVersion: 1,
        sessionKey: "websocket:chat-1",
        messages: [{ role: "assistant", content: "后台完成" }]
      }))
    };

    hydrateAgentThreadInBackground(client as any, dispatch, "chat-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(client.readWebuiThread).toHaveBeenCalledWith("websocket:chat-1");
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      "agent/historyHydrateLoading",
      "agent/historyHydrateLoaded"
    ]);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "agent/historyLoading" }));
  });

  it("background hydrate failures stay scoped to the hydrated chat", async () => {
    const dispatch = vi.fn();
    const client = {
      chatIdToSessionKey: (chatId: string) => `websocket:${chatId}`,
      readWebuiThread: vi.fn(async () => {
        throw new Error("missing thread");
      })
    };

    hydrateAgentThreadInBackground(client as any, dispatch, "chat-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      "agent/historyHydrateLoading",
      "agent/historyHydrateFailed"
    ]);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "agent/error" }));
  });

  it("accepts status_result only for the pending and subscribed chat", () => {
    expect(shouldAcceptAgentStatusResult({
      pendingStatusChatId: "chat-1",
      subscribedChatId: "chat-1",
      resultChatId: "chat-1"
    })).toBe(true);
    expect(shouldAcceptAgentStatusResult({
      pendingStatusChatId: null,
      subscribedChatId: "chat-1",
      resultChatId: "chat-1"
    })).toBe(false);
    expect(shouldAcceptAgentStatusResult({
      pendingStatusChatId: "chat-1",
      subscribedChatId: null,
      resultChatId: "chat-1"
    })).toBe(false);
    expect(shouldAcceptAgentStatusResult({
      pendingStatusChatId: "chat-1",
      subscribedChatId: "chat-2",
      resultChatId: "chat-1"
    })).toBe(false);
  });

  it("requests agent restart through the websocket command path and analytics", () => {
    const restart = vi.fn();
    const ensureChatSubscription = vi.fn();
    const dispatch = vi.fn();
    const track = vi.fn();
    const storage = new MemoryStorage();

    expect(requestAgentRestart({
      chatId: "chat-1",
      connection: { restart },
      ensureChatSubscription,
      dispatch,
      track,
      storage,
      now: () => 1781240000000
    })).toBe(true);

    expect(ensureChatSubscription).toHaveBeenCalledWith("chat-1");
    expect(restart).toHaveBeenCalledWith("chat-1");
    expect(mockCallOrder(ensureChatSubscription)).toBeLessThan(mockCallOrder(restart));
    expect(dispatch).toHaveBeenCalledWith({ type: "agent/restartRequested", startedAt: 1781240000000 });
    expect(track).toHaveBeenCalledWith({ name: "agent_restart_requested", params: { page_path: "/main" }, consentTier: "basic" });
    expect(parseStoredAgentRestartState(storage.getItem(AGENT_RESTART_STATE_STORAGE_KEY))).toEqual({
      chatId: "chat-1",
      startedAt: 1781240000000,
      sawDisconnect: false
    });
  });

  it("does not request restart without a current chat or websocket connection", () => {
    const restart = vi.fn();
    const ensureChatSubscription = vi.fn();
    const dispatch = vi.fn();
    const track = vi.fn();

    expect(requestAgentRestart({ chatId: null, connection: { restart }, ensureChatSubscription, dispatch, track })).toBe(false);
    expect(requestAgentRestart({ chatId: "chat-1", connection: null, ensureChatSubscription, dispatch, track })).toBe(false);
    expect(restart).not.toHaveBeenCalled();
    expect(ensureChatSubscription).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it("subscribes before resetting the current session with slash new", () => {
    const sendMessage = vi.fn();
    const ensureChatSubscription = vi.fn();
    const clearInput = vi.fn();
    const clearPendingMedia = vi.fn();
    const dismissSlashMenu = vi.fn();
    const focusInput = vi.fn();

    expect(requestNewSessionReset({
      chatId: "chat-1",
      connection: { sendMessage },
      ensureChatSubscription,
      clearInput,
      clearPendingMedia,
      dismissSlashMenu,
      focusInput
    })).toBe(true);

    expect(clearInput).toHaveBeenCalledTimes(1);
    expect(clearPendingMedia).toHaveBeenCalledTimes(1);
    expect(dismissSlashMenu).toHaveBeenCalledTimes(1);
    expect(ensureChatSubscription).toHaveBeenCalledWith("chat-1");
    expect(sendMessage).toHaveBeenCalledWith({ chatId: "chat-1", content: "/new" });
    expect(mockCallOrder(ensureChatSubscription)).toBeLessThan(mockCallOrder(sendMessage));
    expect(focusInput).toHaveBeenCalledTimes(1);
  });

  it("opens the system media picker directly from the plus button without rendering a floating media menu", () => {
    const source = readFileSync(homePageSourcePath, "utf8");

    expect(source).toContain("onClick={openMediaFilePicker}");
    expect(source).not.toContain("function ComposerMediaMenu");
    expect(source).not.toContain("setMediaMenuOpen");
    expect(source).not.toContain("aria-haspopup=\"menu\"");
    expect(source).not.toContain("role=\"menuitem\"");
  });

  it("renders composer media previews as compact thumbnail and file chips", () => {
    const html = renderToString(
      <ComposerMediaPreviewStrip
        items={[
          readyImage({ id: "one", fileName: "shot.png", previewUrl: "blob:shot", originalBytes: 2048, encodedBytes: 1024 }),
          { id: "two", sourceKey: "image:broken.png", fileName: "broken.png", kind: "image", previewUrl: "blob:broken", status: "error", originalBytes: 1024, errorKey: "home.media.error.sendReadFailed" },
          readyFile({ id: "three", fileName: "report.pdf", originalBytes: 4096 }),
          readyFile({ id: "doc", fileName: "brief.docx", originalBytes: 3072, uploadMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx" }),
          readyFile({ id: "four", fileName: "sheet.xlsx", originalBytes: 2048, uploadMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: ".xlsx" }),
          readyFile({ id: "deck", fileName: "deck.pptx", originalBytes: 1536, uploadMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: ".pptx" }),
          readyFile({ id: "text", fileName: "notes.txt", originalBytes: 512, uploadMime: "text/plain", extension: ".txt" }),
          readyFile({ id: "csv", fileName: "table.csv", originalBytes: 768, uploadMime: "text/csv", extension: ".csv" }),
          readyFile({ id: "five", fileName: "data.json", originalBytes: 1024, uploadMime: "application/json", extension: ".json" }),
          readyFile({ id: "xml", fileName: "payload.xml", originalBytes: 640, uploadMime: "application/xml", extension: ".xml" })
        ]}
        onRemove={() => undefined}
        removeLabel="移除"
        selectedLabel="已选择媒体"
      />
    );
    const compactHtml = html.replace(/<!-- -->/g, "");

    expect(html).toContain('src="blob:shot"');
    expect(html).toContain('src="blob:broken"');
    expect(html).toContain('data-testid="agent-attachment-card-image"');
    expect(html).toContain('class="agent-attachment-card__action"');
    expect(html).toContain('aria-label="shot.png"');
    expect(html).toContain('data-testid="agent-attachment-card-file"');
    expect(html).toContain("composer-media-preview-strip");
    expect(html).toContain("agent-attachment-card");
    expect(html).toContain("agent-attachment-card__preview");
    expect(html).toContain("agent-attachment-card__name");
    expect(html).toContain("agent-attachment-card__meta");
    expect(html).toContain(">shot<");
    expect(html).toContain(">report<");
    expect(html).toContain(">brief<");
    expect(html).toContain(">sheet<");
    expect(html).toContain(">deck<");
    expect(html).toContain(">notes<");
    expect(html).toContain(">table<");
    expect(html).toContain(">data<");
    expect(html).toContain(">payload<");
    expect(html).toContain(">PDF<");
    expect(html).toContain(">DOC<");
    expect(html).toContain(">XLS<");
    expect(html).toContain(">PPT<");
    expect(html).toContain(">FILE<");
    expect(compactHtml).toContain("XLSX · 2.0 KB");
    expect(compactHtml).toContain("PPTX · 1.5 KB");
    expect(compactHtml).toContain("TXT · 512 B");
    expect(compactHtml).toContain("CSV · 768 B");
    expect(compactHtml).toContain("JSON · 1.0 KB");
    expect(compactHtml).toContain("XML · 640 B");
    expect(html).toContain('data-testid="agent-file-icon-pdf"');
    expect(html).toContain('data-testid="agent-file-icon-docx"');
    expect(html).toContain('data-testid="agent-file-icon-xlsx"');
    expect(html).toContain('data-testid="agent-file-icon-pptx"');
    expect(html).toContain('data-testid="agent-file-icon-file"');
    expect(html).toContain("agent-attachment-card__file-tile--pdf");
    expect(html).toContain("agent-attachment-card__file-tile--docx");
    expect(html).toContain("agent-attachment-card__file-tile--xlsx");
    expect(html).toContain("agent-attachment-card__file-tile--pptx");
    expect(html).toContain("agent-attachment-card__file-tile--file");
    expect(html).toContain('aria-label="PDF file"');
    expect(html).toContain('aria-label="Word document"');
    expect(html).toContain('aria-label="Spreadsheet file"');
    expect(html).toContain('aria-label="Presentation file"');
    expect(html).toContain('aria-label="File attachment"');
    expect(html).not.toContain("absolute -right-1 -bottom-1");
    expect(html).not.toContain('data-testid="composer-file-kind-');
    expect(compactHtml).toContain("PNG · 2.0 KB");
    expect(compactHtml).not.toContain("-&gt;");
    expect(compactHtml).toContain("PDF · 4.0 KB");
    expect(compactHtml).toContain("CSV · 768 B");
    expect(compactHtml).toContain("JSON · 1.0 KB");
    expect(html).toContain("文件读取失败，请重新选择。");
    expect(html).toContain("移除: shot.png");
    expect(html).not.toContain("clip.mp4");
  });

  it("renders send and stop actions as mutually exclusive button states", () => {
    const sendHtml = renderToString(<ComposerSubmitButton isSending={false} disabled={false} sendLabel="发送" stopLabel="停止" onClick={() => undefined} />);
    const stopHtml = renderToString(<ComposerSubmitButton isSending disabled={false} sendLabel="发送" stopLabel="停止" onClick={() => undefined} />);
    const disabledHtml = renderToString(<ComposerSubmitButton isSending={false} disabled sendLabel="发送" stopLabel="停止" onClick={() => undefined} />);

    expect(sendHtml).toContain("发送");
    expect(sendHtml).toContain('data-icon="send"');
    expect(sendHtml).toContain("rounded-full w-7 h-7");
    expect(sendHtml).toContain("bg-action-sky");
    expect(sendHtml).toContain("translate-y-[1px]");
    expect(sendHtml).not.toContain("停止");
    expect(sendHtml).not.toContain('data-icon="pause"');
    expect(sendHtml).not.toContain('data-icon="stop-square"');

    expect(stopHtml).toContain("停止");
    expect(stopHtml).toContain("rounded-full w-7 h-7");
    expect(stopHtml).toContain("bg-action-sky");
    expect(stopHtml).toContain("block shrink-0 bg-white");
    expect(stopHtml).toContain('width:11px');
    expect(stopHtml).not.toContain('data-icon="stop-square"');
    expect(stopHtml).not.toContain("发送");
    expect(stopHtml).not.toContain('data-icon="send"');
    expect(stopHtml).not.toContain('data-icon="pause"');

    expect(disabledHtml).toContain("bg-text-ink/25");
    expect(disabledHtml).toContain("cursor-not-allowed");
    expect(disabledHtml).not.toContain("bg-action-sky");
  });

  it("translates media send error keys for visible agent errors", () => {
    expect(agentErrorText("home.media.error.sendUnsupported")).toBe("当前不支持此文件格式。请上传图片、PDF、Office 文档或文本文件。");
    expect(agentErrorText("home.media.error.sendTooManyAttachments")).toBe("最多 4 个附件。");
    expect(agentErrorText("home.media.error.sendFileSize")).toBe("单个文件不能超过 10 MB。");
    expect(agentErrorText("plain error")).toBe("plain error");
    expect(agentErrorText(null)).toBeNull();
  });

  it("blank composer first send creates chat then sends message", async () => {
    const newChat = vi.fn(async () => "chat-new");
    const sendMessage = vi.fn();
    const ensureChatSubscription = vi.fn();
    const dispatch = vi.fn();
    const track = vi.fn();
    const clearComposer = vi.fn();
    const setCreatingChat = vi.fn();
    const onNewChatMessageSent = vi.fn();
    const encodedBlob = new Blob(["png"], { type: "image/png" });
    const uploadAgentMedia = vi.fn(async () => [
      { path: "/media/websocket/webui/shot.png", url: "http://agent.local/api/media/sig/shot", name: "shot.png", kind: "image" as const, mime: "image/png" as const, bytes: 3 },
      { path: "/media/websocket/webui/小短文.pdf", url: "http://agent.local/api/media/sig/report", name: "小短文.pdf", kind: "file" as const, mime: "application/pdf" as const, bytes: 12 }
    ]);

    await expect(submitAgentComposerMessage({
      chatId: null,
      connection: { newChat, sendMessage },
      ensureChatSubscription,
      content: " 帮我整理计划 ",
      language: "zh-CN",
      pendingAttachments: [
        readyImage({ fileName: "shot.png", encodedBlob, encodedBytes: 3 }),
        readyFile({ fileName: "小短文.pdf", uploadBlob: new Blob(["%PDF-report"], { type: "application/pdf" }), originalBytes: 12 })
      ],
      uploadAgentMedia,
      dispatch,
      track,
      setCreatingChat,
      clearComposer,
      onNewChatMessageSent
    })).resolves.toBe(true);

    expect(newChat).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenNthCalledWith(1, { type: "agent/newChatCreated", chatId: "chat-new" });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: "agent/userMessageQueued",
      chatId: "chat-new",
      content: "帮我整理计划",
      media: [
        { url: "http://agent.local/api/media/sig/shot", name: "shot.png", kind: "image", path: "/media/websocket/webui/shot.png" },
        { url: "http://agent.local/api/media/sig/report", name: "小短文.pdf", kind: "file", path: "/media/websocket/webui/小短文.pdf" }
      ]
    });
    expect(uploadAgentMedia).toHaveBeenCalledWith([
      { blob: encodedBlob, name: "shot.png", kind: "image", mime: "image/png" },
      { blob: expect.any(Blob), name: "小短文.pdf", kind: "file", mime: "application/pdf" }
    ]);
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: "chat-new",
      content: "帮我整理计划",
      language: "zh-CN",
      media: [
        { path: "/media/websocket/webui/shot.png", url: "http://agent.local/api/media/sig/shot", name: "shot.png", kind: "image", mime: "image/png", bytes: 3 },
        { path: "/media/websocket/webui/小短文.pdf", url: "http://agent.local/api/media/sig/report", name: "小短文.pdf", kind: "file", mime: "application/pdf", bytes: 12 }
      ]
    });
    expect(ensureChatSubscription).toHaveBeenCalledWith("chat-new");
    expect(mockCallOrder(dispatch, 1)).toBeLessThan(mockCallOrder(ensureChatSubscription));
    expect(mockCallOrder(ensureChatSubscription)).toBeLessThan(mockCallOrder(sendMessage));
    expect(setCreatingChat).toHaveBeenNthCalledWith(1, true);
    expect(setCreatingChat).toHaveBeenLastCalledWith(false);
    expect(clearComposer).toHaveBeenCalledTimes(1);
    expect(onNewChatMessageSent).toHaveBeenCalledWith("chat-new");
    expect(track).toHaveBeenCalledWith({ name: "agent_send_message", params: { page_path: "/main" }, consentTier: "basic" });
  });

  it("existing chat send does not create a new chat", async () => {
    const newChat = vi.fn(async () => "unused-chat");
    const sendMessage = vi.fn();
    const ensureChatSubscription = vi.fn();
    const dispatch = vi.fn();
    const onNewChatMessageSent = vi.fn();

    await expect(submitAgentComposerMessage({
      chatId: "chat-1",
      connection: { newChat, sendMessage },
      ensureChatSubscription,
      content: "继续",
      pendingAttachments: [],
      uploadAgentMedia: vi.fn(async () => []),
      dispatch,
      track: vi.fn(),
      clearComposer: vi.fn(),
      onNewChatMessageSent
    })).resolves.toBe(true);

    expect(newChat).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: "agent/userMessageQueued", chatId: "chat-1", content: "继续", media: [] });
    expect(ensureChatSubscription).toHaveBeenCalledWith("chat-1");
    expect(sendMessage).toHaveBeenCalledWith({ chatId: "chat-1", content: "继续", media: [] });
    expect(mockCallOrder(dispatch)).toBeLessThan(mockCallOrder(ensureChatSubscription));
    expect(mockCallOrder(ensureChatSubscription)).toBeLessThan(mockCallOrder(sendMessage));
    expect(onNewChatMessageSent).not.toHaveBeenCalled();
  });

  it("newChat failure keeps composer input for retry", async () => {
    const sendMessage = vi.fn();
    const dispatch = vi.fn();
    const clearComposer = vi.fn();

    await expect(submitAgentComposerMessage({
      chatId: null,
      connection: { newChat: vi.fn(async () => { throw new Error("new chat failed"); }), sendMessage },
      content: "不要丢",
      pendingAttachments: [],
      uploadAgentMedia: vi.fn(async () => []),
      dispatch,
      track: vi.fn(),
      clearComposer
    })).resolves.toBe(false);

    expect(dispatch).toHaveBeenCalledWith({ type: "agent/error", message: "new chat failed" });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(clearComposer).not.toHaveBeenCalled();
  });

  it("maps backend file 413 to the current composer file-size error", async () => {
    const sendMessage = vi.fn();
    const dispatch = vi.fn();
    const setComposerMediaError = vi.fn();
    const clearComposer = vi.fn();

    await expect(submitAgentComposerMessage({
      chatId: "chat-1",
      connection: { newChat: vi.fn(async () => "unused-chat"), sendMessage },
      content: "看这个文件",
      pendingAttachments: [readyFile({ fileName: "large.pdf", originalBytes: 10 * 1024 * 1024 + 1 })],
      uploadAgentMedia: vi.fn(async () => { throw new MemmyAgentRequestError("file too large", 413); }),
      dispatch,
      track: vi.fn(),
      setComposerMediaError,
      clearComposer
    })).resolves.toBe(false);

    expect(setComposerMediaError).toHaveBeenCalledWith("home.media.error.sendFileSize");
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "agent/error" }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(clearComposer).not.toHaveBeenCalled();
  });

  it("validates agent attachment limits before websocket send", async () => {
    await expect(validateAgentMediaFiles([
      file("one.png", "image/png", 1024),
      file("report.pdf", "application/pdf", 1024),
      file("data.json", "application/json", 1024),
      file("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 1024)
    ])).resolves.toMatchObject({ duplicateCount: 0 });
    const mixedResult = await validateAgentMediaFiles([
      file("one.png", "image/png", 1024),
      file("report.pdf", "application/pdf", 1024),
      file("data.json", "application/json", 1024),
      file("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 1024)
    ]);
    expect(mixedResult.files).toHaveLength(4);

    await expect(validateAgentMediaFiles([
      file("1.png", "image/png", 1024),
      file("2.pdf", "application/pdf", 1024),
      file("3.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 1024),
      file("4.txt", "text/plain", 1024),
      file("5.json", "application/json", 1024)
    ])).rejects.toThrow("附件最多 4 个");
    await expect(validateAgentMediaFiles([file("big.pdf", "application/pdf", 10 * 1024 * 1024 + 1)])).rejects.toThrow("单个文件不能超过 10 MB");
    await expect(validateAgentMediaFiles([file("huge.png", "image/png", 10 * 1024 * 1024 + 1)])).rejects.toThrow("单个文件不能超过 10 MB");
    await expect(validateAgentMediaFiles([file("max.png", "image/png", 10 * 1024 * 1024)])).resolves.toBeDefined();
    await expect(validateAgentMediaFiles([file("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", 1024)])).resolves.toBeDefined();
    await expect(validateAgentMediaFiles([file("notes.md", "text/markdown", 1024)])).resolves.toBeDefined();
    await expect(validateAgentMediaFiles([file("clip.webm", "video/webm", 1024)])).rejects.toThrow("仅支持 PNG、JPG/JPEG、WebP、GIF 图片，以及 PDF、DOCX、XLSX、PPTX 或文本文件");
    await expect(validateAgentMediaFiles([file("clip.mov", "video/quicktime", 2048)])).rejects.toThrow("仅支持 PNG、JPG/JPEG、WebP、GIF 图片，以及 PDF、DOCX、XLSX、PPTX 或文本文件");
    await expect(validateAgentMediaFiles([file("vector.svg", "image/svg+xml", 1024)])).rejects.toThrow("仅支持 PNG、JPG/JPEG、WebP、GIF 图片，以及 PDF、DOCX、XLSX、PPTX 或文本文件");
    await expect(validateAgentMediaFiles([file("spoof.docx", "text/plain", 1024)])).rejects.toThrow("仅支持 PNG、JPG/JPEG、WebP、GIF 图片，以及 PDF、DOCX、XLSX、PPTX 或文本文件");
    await expect(validateAgentMediaFiles([file("old.doc", "application/msword", 1024)])).rejects.toThrow("仅支持 PNG、JPG/JPEG、WebP、GIF 图片，以及 PDF、DOCX、XLSX、PPTX 或文本文件");
    await expect(validateAgentMediaFiles([file("archive.zip", "application/zip", 1024)])).rejects.toThrow("仅支持 PNG、JPG/JPEG、WebP、GIF 图片，以及 PDF、DOCX、XLSX、PPTX 或文本文件");
    await expect(validateAgentMediaFiles([file("unknown.bin", "", 1024)])).rejects.toThrow("仅支持 PNG、JPG/JPEG、WebP、GIF 图片，以及 PDF、DOCX、XLSX、PPTX 或文本文件");
  });

  it("extracts only image files from pasted clipboard data", () => {
    const pastedImage = file("clipboard.png", "image/png", 1024);
    const fallbackImage = file("fallback.jpg", "image/jpeg", 1024);
    const textFile = file("notes.txt", "text/plain", 1024);
    const textItem = { kind: "string", type: "text/plain", getAsFile: () => null };
    const imageItem = { kind: "file", type: "image/png", getAsFile: () => pastedImage };
    const ignoredFileItem = { kind: "file", type: "text/plain", getAsFile: () => textFile };

    expect(clipboardImageFilesFromDataTransfer({
      items: [textItem, imageItem, ignoredFileItem],
      files: [pastedImage, fallbackImage, textFile]
    })).toEqual([pastedImage]);
    expect(clipboardImageFilesFromDataTransfer({
      items: [textItem, ignoredFileItem],
      files: [fallbackImage, textFile]
    })).toEqual([fallbackImage]);
    expect(clipboardImageFilesFromDataTransfer({
      items: [textItem, ignoredFileItem],
      files: [textFile]
    })).toEqual([]);
    expect(clipboardImageFilesFromDataTransfer(null)).toEqual([]);
  });

  it("does not duplicate copied images exposed through clipboard items and files", () => {
    const itemImage = file("image.png", "image/png", "same-png", 1);
    const fileImage = file("image.png", "image/png", "same-png", 2);
    const imageItem = { kind: "file", type: "image/png", getAsFile: () => itemImage };

    expect(clipboardImageFilesFromDataTransfer({
      items: [imageItem],
      files: [fileImage]
    })).toEqual([itemImage]);
  });

  it("extracts image and file attachments from dropped data transfer payloads", () => {
    const droppedImage = file("drop.png", "image/png", 1024);
    const droppedPdf = file("report.pdf", "application/pdf", 2048);
    const droppedText = file("notes.txt", "text/plain", 512);
    const textItem = { kind: "string", getAsFile: () => null } as const;
    const imageItem = { kind: "file", getAsFile: () => droppedImage } as const;

    expect(attachmentFilesFromDataTransfer({
      items: [textItem, imageItem],
      files: [droppedImage, droppedPdf, droppedText]
    })).toEqual([droppedImage, droppedPdf, droppedText]);
    expect(attachmentFilesFromDataTransfer({
      items: [textItem],
      files: []
    })).toEqual([]);
    expect(dataTransferHasAttachmentFiles({ types: ["Files"] })).toBe(true);
    expect(dataTransferHasAttachmentFiles({ types: ["text/plain"] })).toBe(false);
    expect(dataTransferHasAttachmentFiles(null)).toBe(false);
  });

  it("wires pasted images into both composer textareas", () => {
    const source = readFileSync(homePageSourcePath, "utf8");

    expect(source).toContain("function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>)");
    expect(source).toContain("clipboardImageFilesFromDataTransfer(event.clipboardData)");
    expect(source).toContain("event.preventDefault();");
    expect(source).toContain("void attachMediaFilesToScope(chatScopeKey, files);");
    expect(source.match(/onPaste=\{handleComposerPaste\}/g)).toHaveLength(2);
  });

  it("wires dropped image and file attachments into both composers", () => {
    const source = readFileSync(homePageSourcePath, "utf8");

    expect(source).toContain("function handleComposerDragOver(event: DragEvent<HTMLElement>)");
    expect(source).toContain("function handleComposerDrop(event: DragEvent<HTMLElement>)");
    expect(source).toContain("dataTransferHasAttachmentFiles(event.dataTransfer)");
    expect(source).toContain('event.dataTransfer.dropEffect = "copy";');
    expect(source).toContain("attachmentFilesFromDataTransfer(event.dataTransfer)");
    expect(source).toContain("void attachMediaFilesToScope(chatScopeKey, files).then");
    expect(source.match(/onDragOver=\{handleComposerDragOver\}/g)).toHaveLength(2);
    expect(source.match(/onDrop=\{handleComposerDrop\}/g)).toHaveLength(2);
  });

  it("deduplicates selected attachments by metadata and content hash", async () => {
    const first = file("report.pdf", "application/pdf", "%PDF-same", 100);
    const duplicate = file("report.pdf", "application/pdf", "%PDF-same", 100);
    const duplicateResult = await validateAgentMediaFiles([first, duplicate]);
    expect(duplicateResult.files.map((item) => item.file)).toEqual([first]);
    expect(duplicateResult.duplicateCount).toBe(1);

    const existingValidation = await validateAgentMediaFiles([first]);
    const existing = [fileToPendingAttachment(
      existingValidation.files[0]!.file,
      existingValidation.files[0]!.sourceKey,
      existingValidation.files[0]!.classification
    )];
    const existingDuplicate = await validateAgentMediaFiles([duplicate], undefined, existing);
    expect(existingDuplicate.files).toHaveLength(0);
    expect(existingDuplicate.duplicateCount).toBe(1);

    const differentContent = await validateAgentMediaFiles([
      file("report.pdf", "application/pdf", "%PDF-one", 100),
      file("report.pdf", "application/pdf", "%PDF-two", 100)
    ]);
    expect(differentContent.files).toHaveLength(2);
    expect(differentContent.duplicateCount).toBe(0);
    const differentName = await validateAgentMediaFiles([
      file("report-a.pdf", "application/pdf", "%PDF-same", 100),
      file("report-b.pdf", "application/pdf", "%PDF-same", 100)
    ]);
    expect(differentName.files).toHaveLength(2);
    expect(differentName.duplicateCount).toBe(0);
    const differentModified = await validateAgentMediaFiles([
      file("report.pdf", "application/pdf", "%PDF-same", 100),
      file("report.pdf", "application/pdf", "%PDF-same", 101)
    ]);
    expect(differentModified.files).toHaveLength(2);
    expect(differentModified.duplicateCount).toBe(0);
  });

  it("counts only unique new attachments against the composer limit", async () => {
    const existingFiles = [
      file("a.pdf", "application/pdf", "a", 1),
      file("b.pdf", "application/pdf", "b", 2),
      file("c.pdf", "application/pdf", "c", 3)
    ];
    const existingValidation = await validateAgentMediaFiles(existingFiles);
    const existing = existingValidation.files.map((item) => fileToPendingAttachment(item.file, item.sourceKey, item.classification));

    const mixedSelection = await validateAgentMediaFiles([
      file("a.pdf", "application/pdf", "a", 1),
      file("d.pdf", "application/pdf", "d", 4)
    ], undefined, existing);
    expect(mixedSelection.files).toHaveLength(1);
    expect(mixedSelection.duplicateCount).toBe(1);
    await expect(validateAgentMediaFiles([
      file("d.pdf", "application/pdf", "d", 4),
      file("e.pdf", "application/pdf", "e", 5)
    ], undefined, existing)).rejects.toThrow("附件最多 4 个");
  });

  it("does not read oversized files before rejecting them", async () => {
    const huge = {
      name: "huge.png",
      type: "image/png",
      size: 10 * 1024 * 1024 + 1,
      lastModified: 100,
      arrayBuffer: vi.fn()
    } as unknown as File;

    await expect(validateAgentMediaFiles([huge])).rejects.toThrow("单个文件不能超过 10 MB");
    expect(huge.arrayBuffer).not.toHaveBeenCalled();
  });

  it("surfaces read failures while hashing selected attachments", async () => {
    const broken = {
      name: "broken.pdf",
      type: "application/pdf",
      size: 1024,
      lastModified: 100,
      arrayBuffer: vi.fn(async () => { throw new Error("read failed"); })
    } as unknown as File;

    await expect(validateAgentMediaFiles([broken])).rejects.toThrow("home.media.error.sendReadFailed");
  });

  it("groups reasoning-only and trace rows as one agent activity cluster before final answer", () => {
    // Cursor-style: reasoning and tool-trace activity for one contiguous run
    // merge into a SINGLE collapsible cluster ("Worked for Xm Ys"). Inside that
    // cluster, chronological thought/tool segments alternate naturally — that
    // alternation lives in the render layer, not in separate top-level units.
    const units = buildAgentDisplayUnits([
      { id: "reasoning", role: "assistant", content: "", reasoning: "先分析任务。", isStreaming: true },
      { id: "trace", role: "tool", kind: "trace", content: "web_search()", traces: ["web_search()"] },
      { id: "answer", role: "assistant", content: "完成了。" }
    ], { chatScopeKey: "home-page-test" });

    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({
      type: "activity",
      activityKey: expect.stringContaining("home-page-test::activity::"),
      bodyId: expect.stringContaining("agent-activity-home-page-test-activity-")
    });
    expect((units[0] as { messages: unknown[] }).messages).toHaveLength(2);
    expect(units[1]).toMatchObject({ type: "single", message: { id: "answer" } });
  });
});

function file(name: string, type: string, contentOrSize: string | number, lastModified = 1): File {
  if (typeof contentOrSize === "number") {
    const payload = new TextEncoder().encode(`${name}:${type}:${contentOrSize}:${lastModified}`);
    return {
      name,
      type,
      size: contentOrSize,
      lastModified,
      arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
    } as File;
  }
  const blob = new Blob([contentOrSize], { type });
  return {
    name,
    type,
    size: blob.size,
    lastModified,
    arrayBuffer: () => blob.arrayBuffer()
  } as File;
}

function readyImage(input: {
  id?: string;
  sourceKey?: string;
  fileName: string;
  previewUrl?: string;
  originalBytes?: number;
  encodedBytes?: number;
  encodedBlob?: Blob;
}) {
  return {
    id: input.id ?? "image-id",
    sourceKey: input.sourceKey ?? JSON.stringify(["content-metadata-v1", "image", "image/png", input.fileName, input.originalBytes ?? input.encodedBytes ?? 3, 1, "test-hash"]),
    fileName: input.fileName,
    kind: "image" as const,
    previewUrl: input.previewUrl ?? "blob:image",
    status: "ready" as const,
    encodedBlob: input.encodedBlob ?? new Blob(["png"], { type: "image/png" }),
    encodedMime: "image/png" as const,
    encodedBytes: input.encodedBytes ?? 3,
    originalBytes: input.originalBytes ?? input.encodedBytes ?? 3,
    normalized: false
  };
}

function readyFile(input: {
  id?: string;
  sourceKey?: string;
  fileName: string;
  originalBytes?: number;
  uploadBlob?: Blob;
  uploadMime?: PendingFileAttachment["uploadMime"];
  extension?: string;
}) {
  return {
    id: input.id ?? "file-id",
    sourceKey: input.sourceKey ?? JSON.stringify(["content-metadata-v1", "file", input.uploadMime ?? "application/pdf", input.fileName, input.originalBytes ?? 12, 1, "test-hash"]),
    fileName: input.fileName,
    kind: "file" as const,
    status: "ready" as const,
    originalBytes: input.originalBytes ?? 12,
    uploadBlob: input.uploadBlob ?? new Blob(["%PDF-report"], { type: "application/pdf" }),
    uploadMime: input.uploadMime ?? "application/pdf" as const,
    uploadBytes: input.originalBytes ?? 12,
    extension: input.extension ?? ".pdf"
  };
}

class MemoryStorage implements SlashCommandStorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}
