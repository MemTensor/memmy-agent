/** Pet page module. */
import type { AccountSessionView } from "@memmy/local-api-contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { useApiClients } from "../app/providers.js";
import { FOCUSED_AGENT_CHAT_STORAGE_KEY, readGuidanceCompleted, resolveInitialView, type AppRoutePath } from "../app/routes.js";
import type { MemmyAgentClient, MemmyAgentSessionSummary, MemmyAgentUnsubscribe, MemmyAgentWebSocketConnection, MemmyAgentWsEvent } from "../api/memmy-agent-client.js";
import type { AsrClient } from "../api/asr-client.js";
import { Memmy, type MemmyPose } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";
import { useTaskBus, type Task, type TaskBusAgentMessage, type TaskBusValue } from "../lib/task-bus.js";
import { agentActions, appActions } from "../state/app-actions.js";
import type { AppState } from "../state/app-reducer.js";
import { useAppState } from "../state/app-state.js";
import { isComposingKeyboardEvent } from "../utils/keyboard.js";
import memoIdleUrl from "../assets/mascot/memo-idle-alpha.webm";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, Maximize, Maximize2, Mic, Pause, Send, StopSquare, X } from "./memory/memory-prototype-icons.js";
import { useAsrRecorder } from "./asr-recorder.js";
import { createPetAgentBridge, PetReconnectRecoveryTracker } from "./pet-agent-bridge.js";
import type { AgentArtifactClient } from "./agent-message-content.js";

/** Type definition for display state. */
export type DisplayState = "idle" | "active" | "processing" | "answering";

/** Contract for hotzone rect. */
export interface HotzoneRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** Definition for pet timing. */
export const PET_TIMING = {
  mascotSize: 120,
  hotzoneBuffer: 16,
  hoverExitDelay: 350,
  idleAutoCollapseMs: 8000,
  answerToInputDelay: 1100,
  inactiveSleepMs: 30 * 60 * 1000,
  sessionContinuityMs: 5 * 60 * 1000,
  taskReconcileIntervalMs: 2500
} as const;

/** Definition for pet task reconcile interval ms. */
export const PET_TASK_RECONCILE_INTERVAL_MS = PET_TIMING.taskReconcileIntervalMs;

/** Definition for pet mini task list limit. */
export const PET_MINI_TASK_LIST_LIMIT = 6;

/** Definition for pet canvas. */
export const PET_CANVAS = {
  edgePadding: 24,
  answerBubbleWidth: 288,
  answerPreviewLines: 3,
  inputBubbleWidth: 228
} as const;

/** Definition for pet context menu. */
const PET_CONTEXT_MENU = {
  width: 168,
  height: 92,
  gap: 8
} as const;

/** Contract for pet layout offset. */
export interface PetLayoutOffset {
  x: number;
  y: number;
}

/** Contract for pet context menu position input. */
export interface PetContextMenuPositionInput {
  x: number;
  y: number;
  screenX?: number;
  screenLeft?: number;
  screenWidth?: number;
  mascotSize?: number;
  width?: number;
  height?: number;
  gap?: number;
}

/** Contract for pet context menu position. */
export interface PetContextMenuPosition {
  left: number;
  top: number;
}

/** Contract for mini task list item. */
export interface MiniTaskListItem {
  id: string;
  sessionId: string;
  taskId: string;
  title: string;
  status: Task["status"];
  activityAt: number;
}

/** Contract for pet task reconcile target. */
export interface PetTaskReconcileTarget {
  chatId: string;
  sessionKey: string;
  isRunning: boolean;
}

/** Contract for pet window layout. */
export interface PetWindowLayout {
  width: number;
  height: number;
  mascotOffsetX: number;
  mascotOffsetY: number;
}

/** Contract for pet measured layout input. */
export interface PetMeasuredLayoutInput {
  currentOffset: PetLayoutOffset;
  mascotRect: HotzoneRect;
  contentRects: HotzoneRect[];
  padding: number;
}

/** Contract for pet measured layout. */
export interface PetMeasuredLayout {
  offset: PetLayoutOffset;
  windowLayout: PetWindowLayout;
}

/** Type definition for pet agent event action. */
export type PetAgentEventAction =
  | { type: "ignore" }
  | { type: "append"; text: string }
  | { type: "complete"; text: string }
  | { type: "error"; message: string };

/** Definition for pet transparent root class. */
export const PET_TRANSPARENT_ROOT_CLASS = "memmy-pet-transparent";

/** Contract for display state input. */
export interface DisplayStateInput {
  focusedTask: Task | null;
  hasUndismissedAnswer: boolean;
  isActive: boolean;
  isInHotzone: boolean;
  isActiveSuppressed?: boolean;
}

/** Contract for pet input activity input. */
export interface PetInputActivityInput {
  isTextInputFocused: boolean;
  textInput: string;
  isRecording: boolean;
  hasInteracted: boolean;
}

/** Handles derive display state. */
export function deriveDisplayState(input: DisplayStateInput): DisplayState {
  if (input.focusedTask?.status === "processing") {
    return "processing";
  }

  if (input.hasUndismissedAnswer) {
    return "answering";
  }

  if ((input.isActive || input.isInHotzone) && !input.isActiveSuppressed) {
    return "active";
  }

  return "idle";
}

/** Handles derive pet input activity. */
export function derivePetInputActivity(input: PetInputActivityInput): boolean {
  return input.isTextInputFocused || input.textInput.trim().length > 0 || input.isRecording || input.hasInteracted;
}

/** Handles whether pet input Enter should submit the current message. */
export function shouldSubmitPetInputOnKeyDown(event: ReactKeyboardEvent<HTMLInputElement>, canSend: boolean): boolean {
  return event.key === "Enter" && !event.shiftKey && canSend && !isComposingKeyboardEvent(event);
}

/** Handles compute inside hotzone. */
export function computeInsideHotzone(rects: HotzoneRect[], x: number, y: number, buffer = PET_TIMING.hotzoneBuffer): boolean {
  return rects.some((rect) => {
    if (rect.width === 0 && rect.height === 0) {
      return false;
    }

    return x >= rect.left - buffer && x <= rect.right + buffer && y >= rect.top - buffer && y <= rect.bottom + buffer;
  });
}

/** Handles decide pet session id. */
export function decidePetSessionId(input: { pendingNewSession: boolean; focusedTask: Task | null; lastFinishedTask: Task | null; now?: number }): string | undefined {
  const now = input.now ?? Date.now();

  if (input.pendingNewSession) {
    return undefined;
  }

  if (input.focusedTask) {
    if (input.focusedTask.status === "processing" || input.focusedTask.status === "answering") {
      return input.focusedTask.sessionId;
    }

    if ((input.focusedTask.status === "done" || input.focusedTask.status === "error") && input.focusedTask.finishedAt && now - input.focusedTask.finishedAt <= PET_TIMING.sessionContinuityMs) {
      return input.focusedTask.sessionId;
    }
  }

  if (input.lastFinishedTask?.finishedAt && now - input.lastFinishedTask.finishedAt <= PET_TIMING.sessionContinuityMs) {
    return input.lastFinishedTask.sessionId;
  }

  return undefined;
}

/** Handles resolve focused task route chat id. */
function resolveFocusedTaskRouteChatId(task: Task | null): string | undefined {
  if (!task) {
    return undefined;
  }

  if (task.status === "processing" || task.status === "answering" || task.status === "done" || task.status === "error") {
    return task.sessionId;
  }

  return undefined;
}

/** Handles resolve pet main route session id. */
export function resolvePetMainRouteSessionId(input: { explicitSessionId?: string | null; pendingNewSession: boolean; focusedTask: Task | null; lastFinishedTask: Task | null; rememberedSessionId?: string | null; now?: number }): string | undefined {
  if (input.explicitSessionId) {
    return input.explicitSessionId;
  }

  if (input.rememberedSessionId) {
    return input.rememberedSessionId;
  }

  const focusedSessionId = resolveFocusedTaskRouteChatId(input.focusedTask);
  if (focusedSessionId) {
    return focusedSessionId;
  }

  if (input.pendingNewSession) {
    return undefined;
  }

  return input.lastFinishedTask?.sessionId;
}

/** Handles resolve pet full route. */
export function resolvePetFullRoute(input: Pick<AppState, "bootstrap" | "account"> & { guidanceCompleted?: boolean }): AppRoutePath {
  if (!input.bootstrap) {
    return "/welcome";
  }

  return resolveInitialView({
    bootstrap: input.bootstrap,
    preferredMode: "full",
    accountSession: resolvePetFullRouteAccountSession(input),
    guidanceCompleted: input.guidanceCompleted ?? readGuidanceCompleted(typeof window === "undefined" ? undefined : window.localStorage)
  });
}

function resolvePetFullRouteAccountSession(input: Pick<AppState, "bootstrap" | "account">): AccountSessionView | undefined {
  if (input.bootstrap?.app.userMode !== "account") {
    return undefined;
  }

  if (!input.account.email && !input.account.phoneNumber && !input.account.registeredAt) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    isNewUser: false,
    profile: {
      userId: "",
      email: input.account.email || null,
      phoneNumber: input.account.phoneNumber,
      nickname: input.account.nickname,
      avatarUrl: null,
      planType: null,
      hasFinishedGuide: input.bootstrap.onboarding.completed,
      region: null,
      registeredAt: input.account.registeredAt
    }
  };
}

/** Handles resolve pet main route target. */
export function resolvePetMainRouteTarget(input: { route?: AppRoutePath; explicitSessionId?: string | null; pendingNewSession: boolean; focusedTask: Task | null; lastFinishedTask: Task | null; rememberedSessionId?: string | null; now?: number }): { route: AppRoutePath; agentChatId?: string } {
  const route = input.route ?? "/main";
  if (route !== "/main") {
    return { route };
  }

  const agentChatId = resolvePetMainRouteSessionId(input);
  return agentChatId ? { route: "/main", agentChatId } : { route: "/main" };
}

/** Handles select mini task list items. */
export function selectMiniTaskListItems(tasks: Task[]): MiniTaskListItem[] {
  const sessionItems = groupMiniTaskListSessions(tasks);
  const activityDesc = (a: MiniTaskListItem, b: MiniTaskListItem) => b.activityAt - a.activityAt;
  const running = sessionItems
    .filter((item) => item.status === "processing" || item.status === "answering")
    .sort(activityDesc)
    .slice(0, PET_MINI_TASK_LIST_LIMIT);
  const remainingSlotCount = Math.max(0, PET_MINI_TASK_LIST_LIMIT - running.length);
  const finished = sessionItems
    .filter((item) => item.status === "done" || item.status === "error")
    .sort(activityDesc)
    .slice(0, remainingSlotCount);

  return [...running, ...finished].sort(activityDesc).slice(0, PET_MINI_TASK_LIST_LIMIT);
}

/** Handles resolve pet task reconcile targets. */
export function resolvePetTaskReconcileTargets(input: {
  items: MiniTaskListItem[];
  sessions: MemmyAgentSessionSummary[];
  client: Pick<MemmyAgentClient, "chatIdToSessionKey" | "sessionKeyToChatId">;
}): PetTaskReconcileTarget[] {
  if (input.items.length === 0) {
    return [];
  }

  const sessionByKey = new Map(input.sessions.map((session) => [session.key, session]));
  const seen = new Set<string>();
  const targets: PetTaskReconcileTarget[] = [];

  for (const item of input.items) {
    if (item.status !== "processing" && item.status !== "answering") {
      continue;
    }

    const chatId = normalizePetTaskChatId(item.sessionId, input.client);
    if (!chatId || seen.has(chatId)) {
      continue;
    }

    const sessionKey = input.client.chatIdToSessionKey(chatId);
    const session = sessionByKey.get(sessionKey);
    seen.add(chatId);
    targets.push({
      chatId,
      sessionKey,
      isRunning: session ? typeof session.run_started_at === "number" : true
    });
  }

  return targets;
}

/** Maps map pet thread messages to task bus. */
export function mapPetThreadMessagesToTaskBus(messages: Array<Record<string, unknown>>): TaskBusAgentMessage[] {
  return messages.map((message) => {
    const role = message.role === "user" || message.role === "tool" ? message.role : "assistant";
    const content = typeof message.content === "string" ? message.content : String(message.content ?? "");
    const createdAt = typeof message.createdAt === "number" ? message.createdAt : undefined;
    const isStreaming = message.isStreaming === true;
    return {
      role,
      content,
      ...(createdAt == null ? {} : { createdAt }),
      ...(isStreaming ? { isStreaming } : {})
    };
  });
}

/** Checks has pet thread latest answer. */
export function hasPetThreadLatestAnswer(messages: TaskBusAgentMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || !message.content.trim()) {
      continue;
    }

    return messages.slice(index + 1).some((candidate) => candidate.role === "assistant" && candidate.content.trim().length > 0);
  }
  return false;
}

/** Handles group mini task list sessions. */
function groupMiniTaskListSessions(tasks: Task[]): MiniTaskListItem[] {
  const sessions = new Map<string, Task[]>();
  for (const task of tasks) {
    const sessionTasks = sessions.get(task.sessionId) ?? [];
    sessionTasks.push(task);
    sessions.set(task.sessionId, sessionTasks);
  }

  return Array.from(sessions.entries()).flatMap(([sessionId, sessionTasks]) => {
    const representative = resolveMiniSessionRepresentative(sessionTasks);
    if (!representative || !shouldShowMiniTaskListRepresentative(representative)) {
      return [];
    }

    return [{
      id: sessionId,
      sessionId,
      taskId: representative.id,
      title: representative.title,
      status: representative.status,
      activityAt: Math.max(representative.startedAt, representative.updatedAt, representative.finishedAt ?? 0)
    }];
  });
}

/** Handles resolve mini session representative. */
function resolveMiniSessionRepresentative(tasks: Task[]): Task | null {
  const activityDesc = (a: Task, b: Task) => Math.max(b.startedAt, b.updatedAt, b.finishedAt ?? 0) - Math.max(a.startedAt, a.updatedAt, a.finishedAt ?? 0);
  return tasks.filter((task) => task.status !== "cancelled").sort(activityDesc)[0] ?? null;
}

function shouldShowMiniTaskListRepresentative(task: Task): boolean {
  if (task.status !== "done" && task.status !== "error") {
    return true;
  }

  return task.readAt == null && task.dismissed !== true;
}

/** Normalizes normalize pet task chat id. */
function normalizePetTaskChatId(sessionId: string, client: Pick<MemmyAgentClient, "sessionKeyToChatId">): string {
  const trimmed = sessionId.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("websocket:") ? client.sessionKeyToChatId(trimmed) : trimmed;
}

/** Handles format record seconds. */
export function formatRecordSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export interface PetClickSample {
  timestamp: number;
  screenX: number;
  screenY: number;
}

export interface PetDoubleClickInput {
  clickDetail: number;
  current: PetClickSample;
  previous: PetClickSample | null;
}

export const PET_DOUBLE_CLICK = {
  maxDelayMs: 500,
  maxDistancePx: 8
} as const;

/**
 * Determines whether consecutive pet clicks should expand to full mode.
 *
 * The native click detail remains the primary signal. The timestamp/screen-position fallback covers
 * Windows, where resizing the transparent pet window after the first click can reset the native
 * click count even though the user clicked the same on-screen mascot twice.
 *
 * @param input The native click count plus the current and previous screen-space click samples.
 * @returns true means it should expand to full mode; a plain single click must stay in pet mode.
 */
export function isPetDoubleClick(input: PetDoubleClickInput): boolean {
  if (input.clickDetail >= 2) {
    return true;
  }

  if (!input.previous) {
    return false;
  }

  const elapsedMs = input.current.timestamp - input.previous.timestamp;
  if (elapsedMs <= 0 || elapsedMs > PET_DOUBLE_CLICK.maxDelayMs) {
    return false;
  }

  return Math.abs(input.current.screenX - input.previous.screenX) <= PET_DOUBLE_CLICK.maxDistancePx
    && Math.abs(input.current.screenY - input.previous.screenY) <= PET_DOUBLE_CLICK.maxDistancePx;
}

/**
 * Maps a memmy-agent WebSocket event into a pet TaskBus action.
 *
 * @param event The WebSocket event.
 * @param currentText The answer accumulated so far for the current task.
 * @param fallbackError The fallback text to show when there is no detailed error.
 * @returns A lightweight action that can be applied to the TaskBus.
 */
export function resolvePetAgentEventAction(event: MemmyAgentWsEvent, currentText: string, fallbackError: string): PetAgentEventAction {
  if (event.event === "delta") {
    const text = stringEventText(event);
    return text ? { type: "append", text } : { type: "ignore" };
  }

  if (event.event === "stream_end") {
    const text = stringEventText(event) || currentText;
    return text ? { type: "complete", text } : { type: "ignore" };
  }

  if (event.event === "message") {
    if (event.kind === "progress" || event.kind === "tool_hint" || event.kind === "reasoning") {
      return { type: "ignore" };
    }

    const text = stringEventText(event);
    return text ? { type: "complete", text } : { type: "ignore" };
  }

  if (event.event === "turn_end") {
    return currentText ? { type: "complete", text: currentText } : { type: "ignore" };
  }

  if (event.event === "goal_status" && event.status !== "running") {
    return currentText ? { type: "complete", text: currentText } : { type: "ignore" };
  }

  if (event.event === "error") {
    return { type: "error", message: resolvePetAgentErrorMessage(event, fallbackError) };
  }

  return { type: "ignore" };
}

/**
 * Normalizes pet Agent error text.
 *
 * @param value The error object or WebSocket error event.
 * @param fallback The fallback text to show when there is no readable error.
 * @returns User-visible error text.
 */
export function resolvePetAgentErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim()) {
    return value.message;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["detail", "reason", "message"]) {
      const text = record[key];
      if (typeof text === "string" && text.trim()) {
        return text.trim();
      }
    }
  }

  return fallback;
}

/**
 * Computes the context menu position from the pet's local click point and the available screen space.
 *
 * @param input The pet local coordinates and optional screen bounds.
 * @returns The menu's absolute position relative to the pet root node.
 */
export function resolvePetContextMenuPosition(input: PetContextMenuPositionInput): PetContextMenuPosition {
  const mascotSize = input.mascotSize ?? PET_TIMING.mascotSize;
  const width = input.width ?? PET_CONTEXT_MENU.width;
  const height = input.height ?? PET_CONTEXT_MENU.height;
  const gap = input.gap ?? PET_CONTEXT_MENU.gap;
  let opensLeft = input.x >= mascotSize / 2;

  if (typeof input.screenX === "number" && typeof input.screenLeft === "number" && typeof input.screenWidth === "number" && Number.isFinite(input.screenX) && Number.isFinite(input.screenLeft) && Number.isFinite(input.screenWidth) && input.screenWidth > 0) {
    const screenRight = input.screenLeft + input.screenWidth;
    const canOpenRight = input.screenX + gap + width <= screenRight;
    const canOpenLeft = input.screenX - gap - width >= input.screenLeft;
    if (!canOpenRight && canOpenLeft) {
      opensLeft = true;
    } else if (canOpenRight && !canOpenLeft) {
      opensLeft = false;
    }
  }

  const left = opensLeft ? input.x - width - gap : input.x + gap;
  const minTop = -height + gap;
  const maxTop = mascotSize - gap;
  const top = Math.min(Math.max(input.y - height / 2, minTop), maxTop);

  return {
    left: Math.round(left),
    top: Math.round(top)
  };
}

/**
 * Computes the dynamic pet window layout from the currently visible content rects.
 *
 * @param input The current offset, the Memmy body rect, and the visible content rects.
 * @returns The renderer's next offset and the main-process window layout; returns null when there is no visible content.
 */
export function resolvePetMeasuredLayout(input: PetMeasuredLayoutInput): PetMeasuredLayout | null {
  const visibleRects = [input.mascotRect, ...input.contentRects].filter(isVisibleFiniteRect);
  const contentRect = unionRects(visibleRects);
  if (!contentRect || !isVisibleFiniteRect(input.mascotRect)) {
    return null;
  }

  const offset = {
    x: Math.round(input.currentOffset.x + input.padding - contentRect.left),
    y: Math.round(input.currentOffset.y + input.padding - contentRect.top)
  };
  const offsetDeltaX = offset.x - input.currentOffset.x;
  const offsetDeltaY = offset.y - input.currentOffset.y;

  return {
    offset,
    windowLayout: {
      width: Math.ceil(contentRect.width + input.padding * 2),
      height: Math.ceil(contentRect.height + input.padding * 2),
      mascotOffsetX: Math.round(input.mascotRect.left + offsetDeltaX),
      mascotOffsetY: Math.round(input.mascotRect.top + offsetDeltaY)
    }
  };
}

/**
 * The routed pet entry point.
 *
 * @returns The pet page.
 */
export function PetPage() {
  const { clients } = useApiClients();
  const { state, dispatch } = useAppState();
  const { t } = useTranslation();
  const bus = useTaskBus();
  const busRef = useRef(bus);
  const connectionRef = useRef<MemmyAgentWebSocketConnection | null>(null);
  const connectionPromiseRef = useRef<Promise<MemmyAgentWebSocketConnection> | null>(null);
  const connectionInstanceEpochRef = useRef(0);
  const chatUnsubscribersRef = useRef<Map<string, MemmyAgentUnsubscribe>>(new Map());
  const taskIdByChatIdRef = useRef<Map<string, string>>(new Map());
  const answerTextByTaskIdRef = useRef<Map<string, string>>(new Map());
  const cancelledTaskIdsRef = useRef<Set<string>>(new Set());
  const recoveryTracker = useMemo(() => clients?.memmyAgent ? new PetReconnectRecoveryTracker({
    client: clients.memmyAgent,
    getConnection: () => connectionRef.current,
    completeTask: (taskId, text) => {
      cleanupPetTaskById(taskId);
      busRef.current.completeTask(taskId, text);
    },
    errorTask: (taskId, message) => {
      cleanupPetTaskById(taskId);
      busRef.current.errorTask(taskId, message);
    },
    emptyResponseMessage: t("pet.agentEmptyResponse"),
    recoveryTimeoutMessage: t("home.agent.recoveryTimeout"),
    interruptedMessage: t("home.agent.executionInterrupted")
  }) : null, [clients?.memmyAgent, t]);

  function cleanupPetTaskById(taskId: string): void {
    for (const [chatId, currentTaskId] of taskIdByChatIdRef.current) {
      if (currentTaskId !== taskId) {
        continue;
      }
      taskIdByChatIdRef.current.delete(chatId);
      chatUnsubscribersRef.current.get(chatId)?.();
      chatUnsubscribersRef.current.delete(chatId);
    }
    answerTextByTaskIdRef.current.delete(taskId);
  }

  useEffect(() => {
    busRef.current = bus;
  }, [bus]);

  const navigate = useCallback(
    (path: AppRoutePath) => {
      dispatch(appActions.navigate(path));
    },
    [dispatch]
  );

  const setPetWindow = useCallback((enabled: boolean) => {
    void window.memmy?.setPetWindow?.(enabled).catch((error: unknown) => {
      console.warn("setPetWindow failed", error);
    });
  }, []);

  const handlePetAgentChatEvent = useCallback(
    (chatId: string, event: MemmyAgentWsEvent) => {
      const taskId = taskIdByChatIdRef.current.get(chatId);
      if (!taskId) {
        return;
      }

      const currentText = answerTextByTaskIdRef.current.get(taskId) ?? "";
      const action = resolvePetAgentEventAction(event, currentText, t("pet.agentUnavailable"));
      if (action.type === "ignore") {
        return;
      }

      if (action.type === "append") {
        answerTextByTaskIdRef.current.set(taskId, `${currentText}${action.text}`);
        busRef.current.appendChunk(taskId, action.text);
        return;
      }

      taskIdByChatIdRef.current.delete(chatId);
      answerTextByTaskIdRef.current.delete(taskId);
      recoveryTracker?.remove(taskId);
      if (action.type === "complete") {
        busRef.current.completeTask(taskId, action.text);
      } else {
        busRef.current.errorTask(taskId, action.message);
      }
    },
    [recoveryTracker, t]
  );

  const cleanupPetAgentTaskRun = useCallback(
    (task: Pick<Task, "id" | "sessionId">) => {
      const normalizedChatId = clients?.memmyAgent ? normalizePetTaskChatId(task.sessionId, clients.memmyAgent) : task.sessionId;
      const chatIds = new Set([task.sessionId, normalizedChatId].filter(Boolean));
      for (const chatId of chatIds) {
        taskIdByChatIdRef.current.delete(chatId);
        const unsubscribe = chatUnsubscribersRef.current.get(chatId);
        if (unsubscribe) {
          unsubscribe();
          chatUnsubscribersRef.current.delete(chatId);
        }
      }
      answerTextByTaskIdRef.current.delete(task.id);
      recoveryTracker?.remove(task.id);
    },
    [clients?.memmyAgent, recoveryTracker]
  );

  const ensurePetAgentConnection = useCallback(async () => {
    if (!clients?.memmyAgent) {
      throw new Error(t("pet.agentUnavailable"));
    }

    if (connectionRef.current) {
      return connectionRef.current;
    }

    if (!connectionPromiseRef.current) {
      const instanceEpoch = connectionInstanceEpochRef.current;
      connectionPromiseRef.current = clients.memmyAgent
        .connectWebSocket((event) => {
          if (event.event === "connection_closed") {
            recoveryTracker?.connectionClosed(event.connection_generation ?? 0);
          } else if (event.event === "ready" && typeof event.connection_generation === "number") {
            recoveryTracker?.ready(event.connection_generation);
          }
        })
        .then((connection) => {
          if (connectionInstanceEpochRef.current !== instanceEpoch) {
            connection.close();
            throw new Error(t("pet.agentUnavailable"));
          }

          connectionRef.current = connection;
          const generation = connection.getReadyGeneration();
          if (generation !== null) {
            recoveryTracker?.ready(generation);
          }
          return connection;
        })
        .catch((error) => {
          connectionPromiseRef.current = null;
          throw error;
        });
    }

    return connectionPromiseRef.current;
  }, [clients, recoveryTracker, t]);

  const submitPetAgentTask = useCallback(
    (task: Task, content: string) => {
      const chatId = clients?.memmyAgent ? normalizePetTaskChatId(task.sessionId, clients.memmyAgent) : task.sessionId;
      cancelledTaskIdsRef.current.delete(task.id);
      taskIdByChatIdRef.current.set(chatId, task.id);
      answerTextByTaskIdRef.current.set(task.id, "");

      void ensurePetAgentConnection()
        .then((connection) => {
          if (cancelledTaskIdsRef.current.has(task.id)) {
            cleanupPetAgentTaskRun(task);
            return;
          }

          if (!chatUnsubscribersRef.current.has(chatId)) {
            const unsubscribe = connection.onChat(chatId, (event) => handlePetAgentChatEvent(chatId, event));
            chatUnsubscribersRef.current.set(chatId, unsubscribe);
          }

          const expectedGeneration = connection.getReadyGeneration();
          if (expectedGeneration === null) {
            throw new Error(t("pet.agentUnavailable"));
          }
          recoveryTracker?.register({ taskId: task.id, chatId, submittedContent: content });
          try {
            connection.sendMessage({ chatId, content }, expectedGeneration);
          } catch (error) {
            cleanupPetAgentTaskRun(task);
            throw error;
          }
        })
        .catch((error) => {
          if (cancelledTaskIdsRef.current.has(task.id)) {
            cleanupPetAgentTaskRun(task);
            return;
          }

          taskIdByChatIdRef.current.delete(chatId);
          answerTextByTaskIdRef.current.delete(task.id);
          busRef.current.errorTask(task.id, resolvePetAgentErrorMessage(error, t("pet.agentUnavailable")));
        });
    },
    [cleanupPetAgentTaskRun, clients?.memmyAgent, ensurePetAgentConnection, handlePetAgentChatEvent, recoveryTracker, t]
  );

  const stopPetAgentTask = useCallback(
    (task: Task) => {
      if (task.status !== "processing" && task.status !== "answering") {
        return false;
      }

      const chatId = clients?.memmyAgent ? normalizePetTaskChatId(task.sessionId, clients.memmyAgent) : task.sessionId;
      cancelledTaskIdsRef.current.add(task.id);
      cleanupPetAgentTaskRun(task);
      if (!chatId) {
        return true;
      }

      dispatch(agentActions.stopRequested(chatId));
      dispatch(agentActions.wsEventReceived({ event: "stop_result", chat_id: chatId, stopped: 1 }));
      try {
        connectionRef.current?.stop(chatId);
      } catch (error) {
        console.warn("pet agent stop failed", error);
      }
      return true;
    },
    [cleanupPetAgentTaskRun, clients?.memmyAgent, dispatch]
  );

  useEffect(() => {
    recoveryTracker?.prune(bus.runningTasks.map((task) => task.id));
  }, [bus.runningTasks, recoveryTracker]);

  useEffect(() => {
    return () => {
      connectionInstanceEpochRef.current += 1;
      for (const unsubscribe of chatUnsubscribersRef.current.values()) {
        unsubscribe();
      }
      chatUnsubscribersRef.current.clear();
      connectionRef.current?.close();
      connectionRef.current = null;
      connectionPromiseRef.current = null;
      taskIdByChatIdRef.current.clear();
      answerTextByTaskIdRef.current.clear();
      cancelledTaskIdsRef.current.clear();
      recoveryTracker?.close();
    };
  }, [clients?.memmyAgent, recoveryTracker]);

  return <PetPageView bus={bus} mainRoute={resolvePetFullRoute(state)} onNavigate={navigate} onPetWindowChange={setPetWindow} onSubmitTask={submitPetAgentTask} onStopTask={stopPetAgentTask} asrClient={clients?.asr} memmyAgentClient={clients?.memmyAgent} />;
}

/**
 * Props for the pure pet view.
 *
 * Field meanings:
 * - bus: The current TaskBus value.
 * - onNavigate: The state-router navigation function.
 * - onPetWindowChange: The Electron pet window mode toggle function.
 */
export interface PetPageViewProps {
  bus: TaskBusValue;
  mainRoute?: AppRoutePath;
  onNavigate: (path: AppRoutePath) => void;
  onPetWindowChange?: (enabled: boolean) => void;
  onSubmitTask?: (task: Task, content: string) => void;
  onStopTask?: (task: Task) => boolean;
  asrClient?: AsrClient;
  memmyAgentClient?: MemmyAgentClient;
}

/**
 * Renders the full pet interaction view.
 *
 * @param props The view props.
 * @returns The pet mode node.
 */
export function PetPageView({ bus, mainRoute = "/main", onNavigate, onPetWindowChange, onSubmitTask, onStopTask, asrClient, memmyAgentClient }: PetPageViewProps) {
  const { t } = useTranslation();
  const agentUnavailableMessage = t("pet.agentUnavailable");
  const asrRecorder = useAsrRecorder(asrClient, { emptyAudioMessage: t("pet.asrEmptyAudio") });
  const cancelAsrRecording = asrRecorder.cancel;
  const [layoutOffset, setLayoutOffset] = useState<PetLayoutOffset>({ x: 0, y: 0 });
  const [isInHotzone, setIsInHotzone] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; screenX?: number; screenLeft?: number; screenWidth?: number; sessionId?: string } | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [isActiveSuppressed, setIsActiveSuppressed] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [isTextInputFocused, setIsTextInputFocused] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingSubmitting, setIsRecordingSubmitting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [taskListOpen, setTaskListOpen] = useState(false);
  const [lastActivityAt, setLastActivityAt] = useState(Date.now);
  const [isSleeping, setIsSleeping] = useState(false);
  const [explicitSessionId, setExplicitSessionId] = useState<string | null>(null);

  const layoutOffsetRef = useRef(layoutOffset);
  const lastWindowLayoutRef = useRef<PetWindowLayout | null>(null);
  const lastPetClickRef = useRef<PetClickSample | null>(null);
  const dragStartScreenRef = useRef({ x: 0, y: 0 });
  const dragMovedRef = useRef(false);
  const hoverExitTimerRef = useRef<number | null>(null);
  const answeringFollowupTimerRef = useRef<number | null>(null);
  const idleCollapseTimerRef = useRef<number | null>(null);
  const sleepTimerRef = useRef<number | null>(null);
  const textRef = useRef<HTMLInputElement>(null);
  const hotzoneRegistryRef = useRef<Map<string, HTMLElement>>(new Map());
  const refCacheRef = useRef<Map<string, (element: HTMLElement | null) => void>>(new Map());
  const lastMainRouteSessionIdRef = useRef<string | null>(null);
  const recordingSubmitInFlightRef = useRef(false);
  const runningSessionItemsRef = useRef<MiniTaskListItem[]>([]);
  const focusedTaskRef = useRef<Task | null>(null);

  const { focusedTask, tasks, lastFinishedTask, pendingNewSession } = bus;
  const hasUndismissedAnswer = !!focusedTask && (focusedTask.status === "answering" || focusedTask.status === "done" || focusedTask.status === "error") && !focusedTask.dismissed;
  const displayState = useMemo(
    () => deriveDisplayState({ focusedTask, hasUndismissedAnswer, isActive, isInHotzone, isActiveSuppressed }),
    [focusedTask, hasUndismissedAnswer, isActive, isActiveSuppressed, isInHotzone]
  );
  const miniTaskListItems = useMemo(() => selectMiniTaskListItems(tasks), [tasks]);
  const runningSessionItems = useMemo(() => miniTaskListItems.filter((item) => item.status === "processing" || item.status === "answering"), [miniTaskListItems]);
  const runningSessionCount = runningSessionItems.length;
  const runningSessionReconcileKey = useMemo(
    () => runningSessionItems.map((item) => `${item.sessionId}:${item.taskId}:${item.status}`).join("|"),
    [runningSessionItems]
  );
  const isActiveBubbleRequested = (isActive || isInHotzone) && !isActiveSuppressed;
  const showActiveBubble = displayState === "active" || (hasUndismissedAnswer && isActiveBubbleRequested);
  const showTopBubble = displayState === "processing" || displayState === "answering" || (displayState === "idle" && runningSessionCount > 0);
  const hasLiveInputActivity = derivePetInputActivity({ isTextInputFocused, textInput, isRecording, hasInteracted });
  const hasHoverBlockingActivity = hasLiveInputActivity || displayState === "processing" || displayState === "answering";
  const focusedAgentText = focusedTask?.lastAgentMessage ?? focusedTask?.streamingChunks?.join("") ?? "";
  const hasTaskHistorySwitcher = miniTaskListItems.length > 0;
  const showIdle = displayState === "idle" && runningSessionCount === 0 && !isDragging;
  const memmyPose = resolveMemmyPose(displayState, focusedTask, isSleeping);

  const markActivity = useCallback(() => {
    setLastActivityAt(Date.now());
    setIsSleeping(false);
  }, []);

  const startNativePetWindowDrag = useCallback(
    (event: Pick<MouseEvent | ReactMouseEvent, "clientX" | "clientY">) => {
      window.memmy?.startPetWindowDrag?.({ clientX: event.clientX, clientY: event.clientY });
    },
    []
  );

  const stopNativePetWindowDrag = useCallback(() => {
    window.memmy?.stopPetWindowDrag?.();
  }, []);

  const petAgentBridge = useMemo(
    () =>
      memmyAgentClient
        ? createPetAgentBridge({
            client: memmyAgentClient,
            bus: {
              appendChunk: bus.appendChunk,
              completeTask: bus.completeTask,
              errorTask: bus.errorTask,
              cancelTask: bus.cancelTask
            },
            unavailableMessage: agentUnavailableMessage,
            emptyResponseMessage: t("pet.agentEmptyResponse")
          })
        : null,
    [agentUnavailableMessage, bus.appendChunk, bus.cancelTask, bus.completeTask, bus.errorTask, memmyAgentClient, t]
  );

  useEffect(() => {
    return () => {
      petAgentBridge?.close();
    };
  }, [petAgentBridge]);

  useEffect(() => {
    runningSessionItemsRef.current = runningSessionItems;
  }, [runningSessionItems]);

  useEffect(() => {
    focusedTaskRef.current = focusedTask;
  }, [focusedTask]);

  useEffect(() => {
    if (!memmyAgentClient || !runningSessionReconcileKey) {
      return;
    }

    let cancelled = false;

    const reconcileRunningSessions = async () => {
      const currentRunningSessionItems = runningSessionItemsRef.current;
      if (currentRunningSessionItems.length === 0) {
        return;
      }

      try {
        const sessions = await memmyAgentClient.listSessions();
        if (cancelled) {
          return;
        }

        const targets = resolvePetTaskReconcileTargets({
          items: currentRunningSessionItems,
          sessions,
          client: memmyAgentClient
        });
        if (targets.length === 0) {
          return;
        }

        await Promise.all(targets.map(async (target) => {
          try {
            const thread = await memmyAgentClient.readWebuiThread(target.sessionKey);
            if (cancelled) {
              return;
            }

            const messages = mapPetThreadMessagesToTaskBus(thread.messages);
            if (messages.length === 0 || !hasPetThreadLatestAnswer(messages)) {
              return;
            }

            const currentFocusedTask = focusedTaskRef.current;
            const focusedChatId = currentFocusedTask ? normalizePetTaskChatId(currentFocusedTask.sessionId, memmyAgentClient) : null;
            const isRunning = target.isRunning && thread.last_turn_closed !== true;
            bus.syncAgentConversation({
              sessionIds: [target.chatId, target.sessionKey],
              messages,
              isRunning,
              preserveFocus: target.chatId !== focusedChatId
            });
          } catch (error) {
            console.warn("pet task reconcile thread failed", error);
          }
        }));
      } catch (error) {
        console.warn("pet task reconcile failed", error);
      }
    };

    void reconcileRunningSessions();
    const timer = window.setInterval(() => {
      void reconcileRunningSessions();
    }, PET_TASK_RECONCILE_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer != null) {
        window.clearInterval(timer);
      }
    };
  }, [bus.syncAgentConversation, memmyAgentClient, runningSessionReconcileKey]);

  /**
   * Resets the pet input state.
   */
  const resetPetInputState = useCallback(() => {
    cancelAsrRecording();
    recordingSubmitInFlightRef.current = false;
    setTextInput("");
    setIsTextInputFocused(false);
    setIsRecording(false);
    setIsRecordingSubmitting(false);
    setIsPaused(false);
    setRecordSeconds(0);
    setHasInteracted(false);
  }, [cancelAsrRecording]);

  useEffect(() => {
    layoutOffsetRef.current = layoutOffset;
  }, [layoutOffset]);

  const registerHotzone = useCallback((key: string) => {
    const cached = refCacheRef.current.get(key);
    if (cached) {
      return cached;
    }

    const callback = (element: HTMLElement | null) => {
      if (element) {
        hotzoneRegistryRef.current.set(key, element);
      } else {
        hotzoneRegistryRef.current.delete(key);
      }
    };
    refCacheRef.current.set(key, callback);
    return callback;
  }, []);

  const resolveMainRouteSessionId = useCallback(
    () => mainRoute === "/main" ? resolvePetMainRouteSessionId({ explicitSessionId, pendingNewSession, focusedTask, lastFinishedTask, rememberedSessionId: lastMainRouteSessionIdRef.current }) : undefined,
    [explicitSessionId, focusedTask, lastFinishedTask, mainRoute, pendingNewSession]
  );

  useEffect(() => {
    const selectedSessionId = explicitSessionId ?? resolveFocusedTaskRouteChatId(focusedTask);
    if (explicitSessionId || (selectedSessionId && !lastMainRouteSessionIdRef.current)) {
      lastMainRouteSessionIdRef.current = selectedSessionId ?? null;
    }
  }, [explicitSessionId, focusedTask]);

  useEffect(() => {
    const selectedSessionId = lastMainRouteSessionIdRef.current;
    if (selectedSessionId && !tasks.some((task) => task.sessionId === selectedSessionId)) {
      lastMainRouteSessionIdRef.current = null;
    }
  }, [tasks]);

  const navigateToMain = useCallback((sessionIdOverride?: string) => {
    const agentChatId = mainRoute === "/main" ? sessionIdOverride ?? resolveMainRouteSessionId() : undefined;
    const target: { route: AppRoutePath; agentChatId?: string } = agentChatId ? { route: mainRoute, agentChatId } : { route: mainRoute };
    rememberFocusSession(target.agentChatId);
    if (typeof window !== "undefined" && window.memmy?.setPetWindow) {
      void window.memmy.setPetWindow(false, target).catch((error: unknown) => {
        console.warn("setPetWindow failed", error);
      });
    } else {
      onPetWindowChange?.(false);
    }
    onNavigate(mainRoute);
  }, [mainRoute, onNavigate, onPetWindowChange, resolveMainRouteSessionId]);

  const navigateToAvatarSettings = useCallback(() => {
    if (typeof window !== "undefined" && window.memmy?.setPetWindow) {
      void window.memmy.setPetWindow(false, { route: "/settings", hash: "pet-avatar" }).catch((error: unknown) => {
        console.warn("setPetWindow failed", error);
      });
    } else {
      onPetWindowChange?.(false);
    }
    onNavigate("/settings");
  }, [onNavigate, onPetWindowChange]);

  // Close the pet: hide the transparent pet window; the app keeps running in the menu bar/tray and pet mode can be reopened from the tray.
  const hidePetWindow = useCallback(() => {
    void window.memmy?.hidePetWindow?.()?.catch((error: unknown) => {
      console.warn("hidePetWindow failed", error);
    });
  }, []);

  const decideSession = useCallback(
    () => explicitSessionId ?? decidePetSessionId({ pendingNewSession, focusedTask, lastFinishedTask }),
    [explicitSessionId, focusedTask, lastFinishedTask, pendingNewSession]
  );

  /**
   * Collapses the currently focused answer and returns the pet to its idle state.
   */
  const dismissFocusedTask = useCallback(() => {
    if (!focusedTask || (focusedTask.status !== "answering" && focusedTask.status !== "done" && focusedTask.status !== "error")) {
      return;
    }

    lastMainRouteSessionIdRef.current = focusedTask.sessionId;
    bus.dismissTask(focusedTask.id);
    setExplicitSessionId(null);
    resetPetInputState();
    setIsActive(false);
    setIsActiveSuppressed(true);
    markActivity();
  }, [bus, focusedTask, markActivity, resetPetInputState]);

  const submitInput = useCallback(
    (rawInput?: string) => {
      const value = (rawInput ?? textInput).trim();
      if (!value) {
        return;
      }

      const task = bus.createTask({ input: value, source: "pet", sessionId: decideSession() });
      lastMainRouteSessionIdRef.current = task.sessionId;
      setExplicitSessionId(null);
      if (onSubmitTask) {
        try {
          onSubmitTask(task, value);
        } catch (error) {
          bus.errorTask(task.id, resolvePetAgentErrorMessage(error, t("pet.agentUnavailable")));
        }
      } else if (petAgentBridge) {
        void petAgentBridge.sendTask({ task, content: value }).catch((error: unknown) => {
          bus.errorTask(task.id, toReadablePetAgentError(error, agentUnavailableMessage));
        });
      } else {
        bus.errorTask(task.id, agentUnavailableMessage);
      }
      resetPetInputState();
      setIsActive(false);
      setIsActiveSuppressed(false);
      markActivity();
    },
    [agentUnavailableMessage, bus, decideSession, markActivity, onSubmitTask, petAgentBridge, resetPetInputState, textInput]
  );

  /**
   * Starts pet voice recording.
   */
  const startRecording = useCallback(() => {
    if (recordingSubmitInFlightRef.current || asrRecorder.isStarting) {
      return;
    }

    setIsRecordingSubmitting(false);
    setHasInteracted(true);
    setIsActiveSuppressed(false);
    markActivity();
    void asrRecorder.start()
      .then(() => {
        setIsRecording(true);
        setIsPaused(false);
        setRecordSeconds(0);
      })
      .catch((error: unknown) => {
        setIsRecording(false);
        setIsRecordingSubmitting(false);
        setIsPaused(false);
        setTextInput(toReadableAsrError(error, t));
      });
  }, [asrRecorder, markActivity, t]);

  /**
   * Pauses or resumes the current pet recording.
   */
  const togglePauseRecording = useCallback(() => {
    if (recordingSubmitInFlightRef.current || isRecordingSubmitting) {
      return;
    }

    if (isPaused) {
      asrRecorder.resume();
      setIsPaused(false);
    } else {
      asrRecorder.pause();
      setIsPaused(true);
    }
    setHasInteracted(true);
    setIsActiveSuppressed(false);
    markActivity();
  }, [asrRecorder, isPaused, isRecordingSubmitting, markActivity]);

  /**
   * Ends the pet recording and, after transcription, reuses the text send pipeline.
   */
  const endRecordingAndSend = useCallback(async () => {
    if (recordingSubmitInFlightRef.current) {
      return;
    }

    if (!isRecording) {
      submitInput();
      return;
    }

    recordingSubmitInFlightRef.current = true;
    setIsRecordingSubmitting(true);
    setIsPaused(true);
    try {
      const transcript = await asrRecorder.finishAndTranscribe();
      submitInput(transcript.text);
    } catch (error: unknown) {
      setTextInput(toReadableAsrError(error, t));
    } finally {
      recordingSubmitInFlightRef.current = false;
      setIsRecordingSubmitting(false);
      setIsRecording(false);
      setIsPaused(false);
      setRecordSeconds(0);
    }
  }, [asrRecorder, isRecording, submitInput, t]);

  const startNewPetConversation = useCallback(() => {
    bus.startNewSession();
    lastMainRouteSessionIdRef.current = null;
    setExplicitSessionId(null);
    setTaskListOpen(false);
    resetPetInputState();
    setIsActive(true);
    setIsActiveSuppressed(false);
    markActivity();
  }, [bus, markActivity, resetPetInputState]);

  const stopFocusedPetTask = useCallback(() => {
    if (!focusedTask || (focusedTask.status !== "processing" && focusedTask.status !== "answering")) {
      return;
    }

    lastMainRouteSessionIdRef.current = focusedTask.sessionId;
    const stoppedBySubmitHandler = onStopTask?.(focusedTask) ?? false;
    if (!stoppedBySubmitHandler) {
      petAgentBridge?.stopTask(focusedTask.id);
    }
    bus.cancelTask(focusedTask.id);
    setIsActive(false);
    setIsActiveSuppressed(false);
    markActivity();
  }, [bus, focusedTask, markActivity, onStopTask, petAgentBridge]);

  useEffect(() => {
    if (focusedTask && (focusedTask.status === "done" || focusedTask.status === "error") && !focusedTask.dismissed) {
      bus.focusTask(null);
    }
  }, []);

  useEffect(() => {
    onPetWindowChange?.(true);
  }, [onPetWindowChange]);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.classList.add(PET_TRANSPARENT_ROOT_CLASS);
    body.classList.add(PET_TRANSPARENT_ROOT_CLASS);
    return () => {
      root.classList.remove(PET_TRANSPARENT_ROOT_CLASS);
      body.classList.remove(PET_TRANSPARENT_ROOT_CLASS);
    };
  }, []);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const mascotElement = hotzoneRegistryRef.current.get("mascot");
      if (!mascotElement) {
        return;
      }

      const nextMeasurement = resolvePetMeasuredLayout({
        currentOffset: layoutOffsetRef.current,
        mascotRect: readElementRect(mascotElement),
        contentRects: Array.from(hotzoneRegistryRef.current.values()).map(readElementRect),
        padding: PET_CANVAS.edgePadding
      });
      if (!nextMeasurement) {
        return;
      }

      if (!areOffsetsEqual(layoutOffsetRef.current, nextMeasurement.offset)) {
        layoutOffsetRef.current = nextMeasurement.offset;
        setLayoutOffset(nextMeasurement.offset);
      }

      if (!areWindowLayoutsEqual(lastWindowLayoutRef.current, nextMeasurement.windowLayout)) {
        lastWindowLayoutRef.current = nextMeasurement.windowLayout;
        window.memmy?.syncPetWindowLayout?.(nextMeasurement.windowLayout);
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [contextMenu, displayState, focusedAgentText, isPaused, isRecording, layoutOffset, recordSeconds, runningSessionCount, showActiveBubble, showTopBubble, taskListOpen, tasks.length, textInput]);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    const handleMove = (event: MouseEvent) => {
      const movedX = Math.abs(event.screenX - dragStartScreenRef.current.x);
      const movedY = Math.abs(event.screenY - dragStartScreenRef.current.y);
      if (movedX > 3 || movedY > 3) {
        dragMovedRef.current = true;
      }
      window.memmy?.movePetWindow?.({ clientX: event.clientX, clientY: event.clientY });
      markActivity();
    };

    const handleUp = () => {
      stopNativePetWindowDrag();
      markActivity();
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMove, { passive: true });
    document.addEventListener("mouseup", handleUp);
    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      stopNativePetWindowDrag();
    };
  }, [isDragging, markActivity, stopNativePetWindowDrag]);

  useEffect(() => {
    if (!isRecording || isPaused) {
      return;
    }

    const intervalId = window.setInterval(() => setRecordSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(intervalId);
  }, [isPaused, isRecording]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (isDragging) {
        return;
      }

      const rects = Array.from(hotzoneRegistryRef.current.values())
        .map((element) => element.getBoundingClientRect());
      const inside = computeInsideHotzone(rects, event.clientX, event.clientY);
      setIsInHotzone((current) => (current === inside ? current : inside));
      if (inside) {
        markActivity();
      } else {
        setIsActiveSuppressed(false);
      }
    };

    document.addEventListener("mousemove", onMove, { passive: true });
    return () => document.removeEventListener("mousemove", onMove);
  }, [isDragging, markActivity]);

  useEffect(() => {
    if (isInHotzone) {
      clearTimerRef(hoverExitTimerRef);
      return;
    }

    if (hasHoverBlockingActivity) {
      return;
    }

    clearTimerRef(hoverExitTimerRef);
    hoverExitTimerRef.current = window.setTimeout(() => {
      setIsActive(false);
      hoverExitTimerRef.current = null;
    }, PET_TIMING.hoverExitDelay);
  }, [hasHoverBlockingActivity, isInHotzone]);

  useEffect(() => {
    if (displayState !== "processing") {
      return;
    }

    resetPetInputState();
    setIsActive(false);
    setIsActiveSuppressed(false);
  }, [displayState, resetPetInputState]);

  useEffect(() => {
    if (focusedTask?.status !== "done" && focusedTask?.status !== "error") {
      return;
    }

    if (focusedTask.dismissed) {
      return;
    }

    clearTimerRef(answeringFollowupTimerRef);
    answeringFollowupTimerRef.current = window.setTimeout(() => {
      setIsActive(true);
      setIsActiveSuppressed(false);
      setHasInteracted(false);
      answeringFollowupTimerRef.current = null;
    }, PET_TIMING.answerToInputDelay);

    return () => clearTimerRef(answeringFollowupTimerRef);
  }, [focusedTask?.dismissed, focusedTask?.id, focusedTask?.status]);

  useEffect(() => {
    clearTimerRef(idleCollapseTimerRef);

    if (displayState !== "answering" || runningSessionCount > 0 || isInHotzone || hasLiveInputActivity || !focusedTask) {
      return;
    }

    idleCollapseTimerRef.current = window.setTimeout(() => {
      dismissFocusedTask();
      idleCollapseTimerRef.current = null;
    }, PET_TIMING.idleAutoCollapseMs);

    return () => clearTimerRef(idleCollapseTimerRef);
  }, [dismissFocusedTask, displayState, focusedTask, hasLiveInputActivity, isInHotzone, runningSessionCount]);

  useEffect(() => {
    clearTimerRef(sleepTimerRef);
    const remain = Math.max(PET_TIMING.inactiveSleepMs - (Date.now() - lastActivityAt), 0);
    sleepTimerRef.current = window.setTimeout(() => {
      if (displayState === "idle") {
        setIsSleeping(true);
      }
      sleepTimerRef.current = null;
    }, remain);

    return () => clearTimerRef(sleepTimerRef);
  }, [displayState, lastActivityAt]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      if (contextMenu) {
        setContextMenu(null);
        return;
      }

      if (taskListOpen) {
        setTaskListOpen(false);
        return;
      }

      if (displayState === "answering" && focusedTask) {
        dismissFocusedTask();
        return;
      }

      if (isActive || isRecording) {
        setIsActive(false);
        resetPetInputState();
        setIsActiveSuppressed(true);
        markActivity();
        return;
      }

      if (focusedTask?.status === "done" || focusedTask?.status === "error") {
        dismissFocusedTask();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [contextMenu, dismissFocusedTask, displayState, focusedTask, isActive, isRecording, markActivity, resetPetInputState, taskListOpen]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handler = (event: MouseEvent) => {
      const menu = hotzoneRegistryRef.current.get("contextMenu");
      if (menu && !menu.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    const timeoutId = window.setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handler);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!taskListOpen) {
      return;
    }

    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      const inList = hotzoneRegistryRef.current.get("miniList")?.contains(target);
      const inMascot = hotzoneRegistryRef.current.get("mascot")?.contains(target);
      const inBadge = hotzoneRegistryRef.current.get("badge")?.contains(target);
      if (!inList && !inMascot && !inBadge) {
        setTaskListOpen(false);
      }
    };
    const timeoutId = window.setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handler);
    };
  }, [taskListOpen]);

  useEffect(() => {
    if (!isActive || isRecording) {
      return;
    }

    const handler = (event: KeyboardEvent) => {
      if (event.key.length !== 1 || event.key === " " || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      if (document.activeElement === textRef.current) {
        return;
      }

      event.preventDefault();
      textRef.current?.focus();
      setTextInput((current) => current + event.key);
      setHasInteracted(true);
      setIsActiveSuppressed(false);
      markActivity();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isActive, isRecording, markActivity]);

  useEffect(() => {
    return () => {
      clearTimerRef(hoverExitTimerRef);
      clearTimerRef(answeringFollowupTimerRef);
      clearTimerRef(idleCollapseTimerRef);
      clearTimerRef(sleepTimerRef);
    };
  }, []);

  const handleMemmyMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    dragMovedRef.current = false;
    dragStartScreenRef.current = {
      x: event.screenX,
      y: event.screenY
    };
    startNativePetWindowDrag(event);
    setIsDragging(true);
    markActivity();
  };

  const handleMemmyClick = (event: ReactMouseEvent) => {
    if (dragMovedRef.current) {
      lastPetClickRef.current = null;
      return;
    }

    const currentClick = {
      timestamp: event.timeStamp,
      screenX: event.screenX,
      screenY: event.screenY
    };
    const shouldOpenFullMode = isPetDoubleClick({
      clickDetail: event.detail,
      current: currentClick,
      previous: lastPetClickRef.current
    });
    lastPetClickRef.current = shouldOpenFullMode ? null : currentClick;

    if (shouldOpenFullMode) {
      event.stopPropagation();
      navigateToMain();
      return;
    }

    event.stopPropagation();
    markActivity();

    if (displayState === "answering" && focusedTask) {
      dismissFocusedTask();
      return;
    }

    if (displayState === "idle") {
      setIsActive(true);
      setIsActiveSuppressed(false);
    } else if (displayState === "active") {
      resetPetInputState();
      setIsActive(false);
      setIsActiveSuppressed(true);
    }
  };

  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const petRoot = event.currentTarget.closest<HTMLElement>("[data-pet-root]");
    const rootRect = petRoot?.getBoundingClientRect();
    const rootLeft = rootRect?.left ?? layoutOffsetRef.current.x;
    const rootTop = rootRect?.top ?? layoutOffsetRef.current.y;
    const browserScreen = typeof window === "undefined" ? undefined : (window.screen as Screen & { availLeft?: number });
    setTaskListOpen(false);
    setContextMenu({
      x: Math.round(event.clientX - rootLeft),
      y: Math.round(event.clientY - rootTop),
      screenX: event.screenX,
      screenLeft: browserScreen?.availLeft ?? 0,
      screenWidth: browserScreen?.availWidth,
      sessionId: resolveMainRouteSessionId()
    });
    markActivity();
  };

  return (
    <main className="fixed inset-0 bg-transparent pointer-events-none" data-display-state={displayState}>
      <section
        className="pointer-events-auto absolute select-none"
        data-pet-root="true"
        style={{ left: layoutOffset.x, top: layoutOffset.y, width: PET_TIMING.mascotSize, height: PET_TIMING.mascotSize }}
      >
        {showTopBubble && focusedTask && displayState === "processing" && (
          <ProcessingBubble
            registerRef={registerHotzone("topBubble")}
            title={focusedTask.title}
            label={t("pet.processing")}
            newConversationLabel={t("pet.newConversation")}
            stopLabel={t("pet.stop")}
            onNewConversation={startNewPetConversation}
            onStop={stopFocusedPetTask}
          />
        )}

        {showTopBubble && focusedTask && displayState === "answering" && (
          <AnswerBubble
            registerRef={registerHotzone("topBubble")}
            task={focusedTask}
            streamedText={focusedAgentText}
            artifactClient={memmyAgentClient}
            labels={{
              close: t("common.close"),
              expand: t("pet.answer.expand")
            }}
            onExpand={() => navigateToMain(focusedTask.sessionId)}
            onDismiss={dismissFocusedTask}
          />
        )}

        {showTopBubble && displayState === "idle" && runningSessionCount > 0 && (
          <RunningSummaryStrip
            registerRef={registerHotzone("topBubble")}
            count={runningSessionCount}
            label={t("pet.runningTasks", { count: runningSessionCount })}
            onClick={() => {
              const runningSession = runningSessionItems[0] ?? null;
              lastMainRouteSessionIdRef.current = runningSession?.sessionId ?? null;
              bus.focusTask(runningSession?.taskId ?? null);
            }}
          />
        )}

        <div
          ref={registerHotzone("mascot")}
          className={`relative ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
          style={{ width: PET_TIMING.mascotSize, height: PET_TIMING.mascotSize }}
          onMouseDown={handleMemmyMouseDown}
          onClick={handleMemmyClick}
          onContextMenu={handleContextMenu}
        >
          <div
            className="absolute inset-0 transition-opacity duration-200"
            style={{
              opacity: showIdle ? 1 : 0,
              pointerEvents: "none",
              filter: "drop-shadow(0 8px 16px rgba(17, 29, 28, 0.18))"
            }}
          >
            <video
              src={memoIdleUrl}
              autoPlay
              loop
              muted
              playsInline
              className="drop-shadow-[0_8px_16px_rgba(17,29,28,0.18)]"
              style={{
                width: PET_TIMING.mascotSize,
                height: PET_TIMING.mascotSize,
                objectFit: "cover",
                display: "block"
              }}
            />
          </div>
          <div className="absolute inset-0 transition-opacity duration-200" style={{ opacity: showIdle ? 0 : 1, pointerEvents: "none" }}>
            <Memmy pose={memmyPose} size={PET_TIMING.mascotSize} className={`drop-shadow-[0_8px_16px_rgba(17,29,28,0.18)] ${displayState === "processing" ? "memmy-bob" : ""}`} />
          </div>
        </div>

        {displayState !== "idle" && <ChatWavesProp />}

        {hasTaskHistorySwitcher && (
          <MultiTaskBadge
            registerRef={registerHotzone("badge")}
            count={miniTaskListItems.length}
            title={runningSessionCount > 0 ? t("pet.runningTasks", { count: runningSessionCount }) : t("pet.list.switch")}
            onClick={(event) => {
              event.stopPropagation();
              setTaskListOpen((open) => !open);
              markActivity();
            }}
          />
        )}

        {showActiveBubble && (
          <ListeningInputBubble
            registerRef={registerHotzone("activeBubble")}
            textInput={textInput}
            onTextChange={(value) => {
              setTextInput(value);
              setHasInteracted(true);
              setIsActiveSuppressed(false);
              markActivity();
            }}
            onFocus={() => {
              setIsTextInputFocused(true);
              setIsActiveSuppressed(false);
              markActivity();
            }}
            onBlur={() => setIsTextInputFocused(false)}
            isRecording={isRecording}
            isSubmittingRecording={isRecordingSubmitting}
            isPaused={isPaused}
            recordSeconds={recordSeconds}
            textRef={textRef}
            labels={{
              placeholder: t("pet.input.placeholder"),
              clickToTalk: t("pet.recording.clickToTalk"),
              send: t("pet.input.send"),
              listening: t("pet.recording.listening"),
              transcribing: t("pet.recording.transcribing"),
              paused: t("pet.recording.paused"),
              continue: t("pet.recording.continue"),
              pause: t("pet.recording.pause"),
              finish: t("pet.recording.finish")
            }}
            onStartRecord={startRecording}
            onTogglePause={togglePauseRecording}
            onEndRecord={endRecordingAndSend}
            onSubmit={() => submitInput()}
          />
        )}

        {taskListOpen && (
          <MiniTaskList
            registerRef={registerHotzone("miniList")}
            tasks={miniTaskListItems}
            focusedSessionId={focusedTask?.sessionId ?? null}
            labels={{
              title: runningSessionCount > 0 ? t("pet.list.running", { count: runningSessionCount }) : t("pet.list.switch"),
              expand: t("pet.list.fullMode"),
              empty: t("pet.list.empty"),
              justNow: t("pet.time.justNow")
            }}
            onPick={(item) => {
              if (item.status === "done" || item.status === "error") {
                bus.markTaskRead(item.taskId);
              }
              bus.focusTask(item.taskId);
              lastMainRouteSessionIdRef.current = item.sessionId;
              setExplicitSessionId(item.sessionId);
              setTaskListOpen(false);
              setIsActive(true);
              setIsActiveSuppressed(false);
              setHasInteracted(false);
              markActivity();
            }}
            onExpand={() => {
              setTaskListOpen(false);
              navigateToMain();
            }}
          />
        )}

        {contextMenu && (
          <PetContextMenu
            registerRef={registerHotzone("contextMenu")}
            x={contextMenu.x}
            y={contextMenu.y}
            screenX={contextMenu.screenX}
            screenLeft={contextMenu.screenLeft}
            screenWidth={contextMenu.screenWidth}
            labels={{
              fullMode: t("pet.context.fullMode"),
              hidePet: t("pet.context.hidePet"),
              avatar: t("pet.context.avatar")
            }}
            onExpand={() => {
              setContextMenu(null);
              navigateToMain(contextMenu.sessionId ?? undefined);
            }}
            onHidePet={() => {
              setContextMenu(null);
              hidePetWindow();
            }}
            onChangeAvatar={() => {
              setContextMenu(null);
              navigateToAvatarSettings();
            }}
          />
        )}
      </section>
    </main>
  );
}

/**
 * Hotzone ref registration function.
 */
type RegisterRef = (element: HTMLElement | null) => void;


/**
 * Renders the sound waves for the small thinking bubble.
 *
 * @returns The sound wave SVG.
 */
function ChatWavesProp() {
  return (
    <div className="absolute pointer-events-none animate-in fade-in duration-300" style={{ right: -14, top: 16 }} aria-hidden="true">
      <svg width="32" height="32" viewBox="0 0 32 32" style={{ overflow: "visible" }}>
        <g fill="none" stroke="#5cbfae" strokeWidth="1.8" strokeLinecap="round">
          <path d="M 4 12 Q 7 16 4 20" className="walkie-wave walkie-wave-1" />
          <path d="M 10 8 Q 17 16 10 24" className="walkie-wave walkie-wave-2" />
          <path d="M 16 4 Q 26 16 16 28" className="walkie-wave walkie-wave-3" />
        </g>
      </svg>
    </div>
  );
}

/**
 * Props for the processing bubble.
 */
interface ProcessingBubbleProps {
  registerRef: RegisterRef;
  title: string;
  label: string;
  newConversationLabel: string;
  stopLabel: string;
  onNewConversation: () => void;
  onStop: () => void;
}

/**
 * Renders the processing bubble.
 *
 * @param props The processing bubble props.
 * @returns The processing bubble node.
 */
function ProcessingBubble({ registerRef, title, label, newConversationLabel, stopLabel, onNewConversation, onStop }: ProcessingBubbleProps) {
  return (
    <div ref={registerRef} className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-background-paper rounded-card shadow-lg border border-border-stone min-w-[180px] max-w-[260px] animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center gap-2">
        <Loader2 size={13} className="text-action-sky animate-spin shrink-0" />
        <span className="text-xs font-normal text-text-ink/85">{label}</span>
      </div>
      <div className="mt-1 text-[11px] text-text-ink/55 line-clamp-1">{title}</div>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onNewConversation();
          }}
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-action-sky hover:text-action-sky-hover cursor-pointer"
        >
          <span aria-hidden="true">+</span>
          {newConversationLabel}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onStop();
          }}
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-status-error hover:text-status-error/80 cursor-pointer"
        >
          <StopSquare size={10} />
          {stopLabel}
        </button>
      </div>
      <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-background-paper border-r border-b border-border-stone rotate-45" />
    </div>
  );
}

/**
 * Props for the answer bubble.
 */
interface AnswerBubbleProps {
  registerRef: RegisterRef;
  task: Task;
  streamedText: string;
  artifactClient?: AgentArtifactClient | null;
  labels: {
    close: string;
    expand: string;
  };
  onExpand: () => void;
  onDismiss: () => void;
}

/**
 * Renders the answer bubble.
 *
 * @param props The answer bubble props.
 * @returns The answer bubble node.
 */
function AnswerBubble({ registerRef, task, streamedText, labels, onExpand, onDismiss }: AnswerBubbleProps) {
  const isError = task.status === "error";
  const isAnswering = task.status === "answering";
  const answerPreviewRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);

  const plainText = useMemo(() => stripMarkdownForPetPreview(streamedText), [streamedText]);

  useLayoutEffect(() => {
    const node = answerPreviewRef.current;
    if (!node) return;

    const overflowing = node.scrollHeight > node.clientHeight + 1;
    setIsOverflowing(overflowing);

    if (shouldAutoScrollRef.current) {
      isProgrammaticScrollRef.current = true;
      node.scrollTop = node.scrollHeight;
      setIsScrolledToBottom(true);
      window.setTimeout(() => { isProgrammaticScrollRef.current = false; }, 120);
    } else {
      const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 4;
      setIsScrolledToBottom(atBottom);
    }
  }, [plainText]);

  useEffect(() => {
    shouldAutoScrollRef.current = true;
    setIsScrolledToBottom(true);
  }, [task.id]);

  const handleWheel = useCallback(() => {
    userScrollIntentUntilRef.current = Date.now() + 600;
  }, []);

  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;
    const node = answerPreviewRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 4;
    if (atBottom) {
      shouldAutoScrollRef.current = true;
      setIsScrolledToBottom(true);
      return;
    }
    if (Date.now() > userScrollIntentUntilRef.current) return;
    shouldAutoScrollRef.current = false;
    setIsScrolledToBottom(false);
  }, []);

  return (
    <div ref={registerRef} className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 bg-background-paper rounded-card shadow-xl border border-border-stone animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <span className="shrink-0">{isError ? <AlertCircle size={13} className="text-status-error" /> : isAnswering ? <Loader2 size={13} className="text-action-sky animate-spin" /> : <CheckCircle2 size={13} className="text-status-success" />}</span>
          <div className="min-w-0 flex-1 text-[10px] text-text-ink/50 line-clamp-1">{task.title}</div>
          <button type="button" onClick={onDismiss} title={labels.close} className="shrink-0 -mr-1 p-1 text-text-ink/35 hover:text-text-ink/70 rounded-md hover:bg-canvas-oat/60 transition-colors cursor-pointer">
            <X size={12} />
          </button>
        </div>
        <div
          ref={answerPreviewRef}
          className="pet-answer-preview-frame mt-2"
          data-overflowing={isOverflowing && !isScrolledToBottom ? "true" : "false"}
          onWheel={handleWheel}
          onScroll={handleScroll}
        >
          <p className="pet-answer-preview-text">{plainText}{isAnswering ? <span className="agent-streaming-cursor" aria-hidden="true" /> : null}</p>
        </div>
      </div>
      <button type="button" onClick={onExpand} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 border-t border-border-stone/40 text-[11px] font-semibold text-action-sky hover:bg-action-sky/8 transition-colors cursor-pointer">
        {labels.expand} <Maximize2 size={10} />
      </button>
      <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-background-paper border-r border-b border-border-stone rotate-45" />
    </div>
  );
}

/**
 * Props for the input bubble.
 *
 * Field meanings:
 * - registerRef: Registers into the merged hotzone.
 * - textInput: The current unsent text.
 * - onTextChange: The text-change callback.
 * - onFocus/onBlur: The text field focus-state callbacks.
 * - isRecording: Whether recording is in progress.
 * - isSubmittingRecording: Whether the recording transcription is being submitted.
 * - isPaused: Whether recording is paused.
 * - recordSeconds: The recording timer in seconds.
 * - onStartRecord/onTogglePause/onEndRecord: The recording control callbacks.
 * - onSubmit: Submits the current input.
 * - textRef: The input box ref held by the parent, used for direct-typing discoverability.
 * - labels: The i18n label set.
 */
interface ListeningInputBubbleProps {
  registerRef: RegisterRef;
  textInput: string;
  onTextChange: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  isRecording: boolean;
  isSubmittingRecording: boolean;
  isPaused: boolean;
  recordSeconds: number;
  onStartRecord: () => void;
  onTogglePause: () => void;
  onEndRecord: () => void;
  onSubmit: () => void;
  textRef: RefObject<HTMLInputElement | null>;
  labels: {
    placeholder: string;
    clickToTalk: string;
    send: string;
    listening: string;
    transcribing: string;
    paused: string;
    continue: string;
    pause: string;
    finish: string;
  };
}

/**
 * Renders the input and recording pill.
 *
 * @param props The input bubble props.
 * @returns The input bubble node.
 */
function ListeningInputBubble({ registerRef, textInput, onTextChange, onFocus, onBlur, isRecording, isSubmittingRecording, isPaused, recordSeconds, onStartRecord, onTogglePause, onEndRecord, onSubmit, textRef, labels }: ListeningInputBubbleProps) {
  const canSend = textInput.trim().length > 0;
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!shouldSubmitPetInputOnKeyDown(event, canSend)) {
      return;
    }
    event.preventDefault();
    onSubmit();
  };

  return (
    <div
      ref={registerRef}
      className={`absolute z-[220] flex items-center gap-1 bg-background-paper rounded-full pl-3.5 pr-1 py-0.5 animate-in fade-in slide-in-from-top-1 duration-200 ${isRecording ? "w-[228px]" : "w-[220px]"}`}
      style={{ top: PET_TIMING.mascotSize - 38, left: "50%", transform: "translateX(-50%)", boxShadow: "0 8px 24px rgba(17,29,28,0.12), 0 1px 3px rgba(17,29,28,0.06)" }}
      onClick={(event) => event.stopPropagation()}
    >
      {isRecording ? (
        <RecordingMeter isPaused={isPaused} isTranscribing={isSubmittingRecording} seconds={recordSeconds} labels={{ listening: labels.listening, transcribing: labels.transcribing, paused: labels.paused }} />
      ) : (
        <input ref={textRef} type="text" value={textInput} onChange={(event) => onTextChange(event.target.value)} onFocus={onFocus} onBlur={onBlur} onKeyDown={handleKeyDown} placeholder={labels.placeholder} className="pet-input-bubble__field flex-1 bg-transparent outline-none text-[11px] min-w-0 py-1.5 text-text-ink" />
      )}

      {isRecording ? (
        <>
          <button type="button" onClick={onTogglePause} disabled={isSubmittingRecording} className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${isPaused ? "bg-status-error/12 text-status-error hover:bg-status-error/20" : "bg-status-error text-white hover:brightness-105"}`} title={isPaused ? labels.continue : labels.pause}>
            {isPaused ? <Mic size={11} /> : <Pause size={11} />}
          </button>
          <button type="button" onClick={onEndRecord} disabled={isSubmittingRecording} className="shrink-0 w-6 h-6 bg-action-sky text-white rounded-full flex items-center justify-center cursor-pointer hover:bg-action-sky-hover transition-colors disabled:opacity-55 disabled:cursor-not-allowed shadow-sm" title={labels.finish}>
            {isSubmittingRecording ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
          </button>
        </>
      ) : (
        <>
          <button type="button" onClick={onStartRecord} className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-text-ink/40 hover:text-action-sky hover:bg-canvas-oat/50 transition-colors cursor-pointer" title={labels.clickToTalk}>
            <Mic size={13} />
          </button>
          <button type="button" onClick={() => canSend && onSubmit()} disabled={!canSend} className="shrink-0 w-7 h-7 bg-action-sky text-white rounded-full flex items-center justify-center cursor-pointer hover:bg-action-sky-hover transition-colors disabled:opacity-35 disabled:cursor-not-allowed shadow-sm" title={labels.send}>
            <Send size={12} />
          </button>
        </>
      )}
    </div>
  );
}

function stringEventText(event: MemmyAgentWsEvent): string {
  const text = typeof event.text === "string" ? event.text : typeof event.content === "string" ? event.content : "";
  return text;
}

/**
 * Props for the recording meter.
 */
interface RecordingMeterProps {
  isPaused: boolean;
  isTranscribing: boolean;
  seconds: number;
  labels: {
    listening: string;
    transcribing: string;
    paused: string;
  };
}

/**
 * Renders the recording waveform and timer.
 *
 * @param props The recording meter props.
 * @returns The recording meter node.
 */
function RecordingMeter({ isPaused, isTranscribing, seconds, labels }: RecordingMeterProps) {
  const isMuted = isPaused || isTranscribing;
  const label = isTranscribing ? labels.transcribing : isPaused ? labels.paused : labels.listening;

  return (
    <div className="flex-1 flex items-center gap-2 min-w-0 py-1.5">
      <div className="flex items-end gap-[2.5px] h-3.5 shrink-0" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((index) => (
          <span key={index} className={`w-[2.5px] rounded-full bg-status-error ${isMuted ? "opacity-25" : `rec-bar rec-bar-${index}`}`} style={{ height: 14 }} />
        ))}
      </div>
      <span className={`text-[13px] font-semibold shrink-0 ${isMuted ? "text-text-ink/45" : "text-text-ink/70"}`}>{label}</span>
      <span className="text-[11px] tabular-nums text-text-ink/40 shrink-0">{formatRecordSeconds(seconds)}</span>
    </div>
  );
}

/**
 * Props for the running-tasks summary strip.
 */
interface RunningSummaryStripProps {
  registerRef: RegisterRef;
  count: number;
  label: string;
  onClick: () => void;
}

/**
 * Renders the running-tasks summary strip in the idle state.
 *
 * @param props The summary strip props.
 * @returns The summary strip node.
 */
function RunningSummaryStrip({ registerRef, count, label, onClick }: RunningSummaryStripProps) {
  return (
    <button ref={registerRef} type="button" onClick={onClick} className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-background-paper/95 border border-border-stone/60 rounded-pill shadow text-[11px] text-text-ink/70 hover:text-action-sky flex items-center justify-center gap-1.5 cursor-pointer transition-colors" style={{ minWidth: 156, maxWidth: PET_CANVAS.answerBubbleWidth }} title={label}>
      <Loader2 size={10} className="text-action-sky animate-spin shrink-0" />
      <span data-running-count={count} className="min-w-0 text-center leading-snug whitespace-normal break-words">
        {label}
      </span>
    </button>
  );
}

/**
 * Props for the multi-task badge.
 */
interface MultiTaskBadgeProps {
  registerRef: RegisterRef;
  count: number;
  title: string;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

/**
 * Renders the multi-task count badge.
 *
 * @param props The badge props.
 * @returns The count badge node.
 */
function MultiTaskBadge({ registerRef, count, title, onClick }: MultiTaskBadgeProps) {
  return (
    <button ref={registerRef} type="button" onClick={onClick} className="absolute min-w-[20px] h-5 px-1.5 rounded-full bg-icon-ember text-white text-[10px] font-bold flex items-center justify-center shadow-md ring-2 ring-canvas-oat hover:scale-110 transition-transform cursor-pointer animate-in zoom-in-50 duration-200" style={{ top: -4, right: -12 }} title={title} data-task-count={count}>
      {count}
    </button>
  );
}

/**
 * Props for the mini task list.
 */
interface MiniTaskListProps {
  registerRef: RegisterRef;
  tasks: MiniTaskListItem[];
  focusedSessionId: string | null;
  labels: {
    title: string;
    expand: string;
    empty: string;
    justNow: string;
  };
  onPick: (item: MiniTaskListItem) => void;
  onExpand: () => void;
}

/**
 * Renders the multi-task mini list.
 *
 * @param props The mini list props.
 * @returns The mini list node.
 */
function MiniTaskList({ registerRef, tasks, focusedSessionId, labels, onPick, onExpand }: MiniTaskListProps) {
  return (
    <div ref={registerRef} className="absolute top-0 right-full mr-3 w-64 bg-background-paper rounded-card shadow-xl border border-border-stone overflow-hidden animate-in fade-in slide-in-from-right-2 duration-200 z-50">
      <div className="px-3 py-2 border-b border-border-stone/40 flex items-center justify-between">
        <span className="text-xs font-semibold text-text-ink/80">{labels.title}</span>
        <button type="button" onClick={onExpand} className="text-[10px] text-text-ink/55 hover:text-action-sky cursor-pointer">
          {labels.expand}
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {tasks.length === 0 && <div className="px-3 py-5 text-center text-[11px] text-text-ink/40">{labels.empty}</div>}
        {tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            onClick={() => onPick(task)}
            className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors cursor-pointer ${task.sessionId === focusedSessionId ? "bg-action-sky/8" : "hover:bg-canvas-oat/50"}`}
            data-session-id={task.sessionId}
            data-task-id={task.taskId}
            data-task-status={task.status}
            data-activity-at={task.activityAt}
          >
            <span className="shrink-0">
              <MiniTaskStatusIcon status={task.status} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-xs text-text-ink/85 line-clamp-1">{task.title}</span>
            </span>
            <span className="shrink-0 text-[10px] text-text-ink/45 tabular-nums">{relativeTime(task.activityAt, labels.justNow)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Renders the status icon for the mini task list.
 *
 * @param props.status The task status.
 * @returns The status icon node.
 */
function MiniTaskStatusIcon({ status }: { status: Task["status"] }) {
  if (status === "processing" || status === "answering") {
    return <Loader2 size={12} className="text-action-sky animate-spin" />;
  }

  if (status === "done") {
    return <CheckCircle2 size={12} className="text-status-success" />;
  }

  return <AlertTriangle size={12} className="text-status-error" />;
}

/**
 * Props for the context menu.
 */
interface PetContextMenuProps {
  registerRef: RegisterRef;
  x: number;
  y: number;
  screenX?: number;
  screenLeft?: number;
  screenWidth?: number;
  labels: {
    fullMode: string;
    hidePet: string;
    avatar: string;
  };
  onExpand: () => void;
  onHidePet: () => void;
  onChangeAvatar: () => void;
}

/**
 * Renders the pet context menu.
 *
 * @param props The menu props.
 * @returns The context menu node.
 */
function PetContextMenu({ registerRef, x, y, screenX, screenLeft, screenWidth, labels, onExpand, onHidePet }: PetContextMenuProps) {
  const { left, top } = resolvePetContextMenuPosition({ x, y, screenX, screenLeft, screenWidth });

  return (
    <div ref={registerRef} className="absolute z-[150] py-1.5 bg-background-paper rounded-card shadow-xl border border-border-stone/50 animate-in fade-in zoom-in-95 duration-150 pointer-events-auto" style={{ left, top, width: PET_CONTEXT_MENU.width, minWidth: PET_CONTEXT_MENU.width }} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
      <button type="button" onClick={onExpand} className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-text-ink/80 whitespace-nowrap hover:bg-canvas-oat/60 transition-colors cursor-pointer">
        <Maximize size={14} className="text-text-ink/55 shrink-0" />
        {labels.fullMode}
      </button>
      <button type="button" onClick={onHidePet} className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-text-ink/80 whitespace-nowrap hover:bg-canvas-oat/60 transition-colors cursor-pointer">
        <X size={14} className="text-text-ink/55 shrink-0" />
        {labels.hidePet}
      </button>
    </div>
  );
}

/**
 * Resolves the Memmy pose from the displayState and the task.
 *
 * @param displayState The current display state.
 * @param focusedTask The focused task.
 * @param isSleeping Whether to enter the sleep pose.
 * @returns The Memmy pose.
 */
function resolveMemmyPose(displayState: DisplayState, focusedTask: Task | null, isSleeping: boolean): MemmyPose {
  if (displayState === "idle" && isSleeping) {
    return "sleep";
  }

  if (displayState === "processing") {
    return "think";
  }

  if (displayState === "answering" && focusedTask?.status === "done") {
    return "celebrate";
  }

  if (displayState === "answering" && focusedTask?.status === "answering") {
    return "chat";
  }

  if (displayState === "answering" && focusedTask?.status === "error") {
    return "think";
  }

  if (displayState === "active") {
    return "chat";
  }

  return "neutral";
}

/**
 * Records the session that full mode should focus on.
 *
 * @param sessionId The session id that full mode should focus on.
 */
function rememberFocusSession(sessionId: string | undefined): void {
  if (!sessionId || typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(FOCUSED_AGENT_CHAT_STORAGE_KEY, sessionId);
  } catch {
    // When sessionStorage is unavailable, only the focus hint is lost; navigation is unaffected.
  }
}

/**
 * Computes a relative time.
 *
 * @param timestamp The timestamp.
 * @returns A short relative-time label.
 */
function relativeTime(timestamp: number, justNowLabel: string): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) {
    return justNowLabel;
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h`;
  }
  return `${Math.floor(diff / 86_400_000)}d`;
}

/**
 * Reads an element's rect within the viewport.
 *
 * @param element The DOM element to measure.
 * @returns A serializable hotzone rect.
 */
function readElementRect(element: HTMLElement): HotzoneRect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  };
}

/**
 * Merges multiple visible rects.
 *
 * @param rects The set of candidate rects.
 * @returns The union rect, or null when there are no valid rects.
 */
function unionRects(rects: HotzoneRect[]): HotzoneRect | null {
  const visibleRects = rects.filter(isVisibleFiniteRect);
  if (visibleRects.length === 0) {
    return null;
  }

  const left = Math.min(...visibleRects.map((rect) => rect.left));
  const top = Math.min(...visibleRects.map((rect) => rect.top));
  const right = Math.max(...visibleRects.map((rect) => rect.right));
  const bottom = Math.max(...visibleRects.map((rect) => rect.bottom));
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top
  };
}

/**
 * Determines whether a rect is visible and all its bounds are finite.
 *
 * @param rect The rect to validate.
 * @returns Whether it can participate in pet window measurement.
 */
function isVisibleFiniteRect(rect: HotzoneRect): boolean {
  return rect.width > 0 && rect.height > 0 && Number.isFinite(rect.left) && Number.isFinite(rect.top) && Number.isFinite(rect.right) && Number.isFinite(rect.bottom);
}

/**
 * Compares whether two local layout offsets are identical.
 *
 * @param left The left offset.
 * @param right The right offset.
 * @returns Whether they are exactly equal.
 */
function areOffsetsEqual(left: PetLayoutOffset, right: PetLayoutOffset): boolean {
  return left.x === right.x && left.y === right.y;
}

/**
 * Compares whether two window layouts are identical.
 *
 * @param left The previously reported layout.
 * @param right The layout measured this time.
 * @returns Whether they are exactly equal.
 */
function areWindowLayoutsEqual(left: PetWindowLayout | null, right: PetWindowLayout): boolean {
  return !!left && left.width === right.width && left.height === right.height && left.mascotOffsetX === right.mascotOffsetX && left.mascotOffsetY === right.mascotOffsetY;
}

/**
 * Clears a timeout ref.
 *
 * @param ref The timeout id ref.
 */
function clearTimerRef(ref: { current: number | null }): void {
  if (ref.current !== null) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
}

/**
 * Produces a pet ASR error message.
 *
 * @param error An unknown exception.
 * @returns Error text that can be shown in the input box.
 */
function toReadableAsrError(error: unknown, t: ReturnType<typeof useTranslation>["t"]): string {
  return error instanceof Error && error.message
    ? t("pet.asrFailedWithMessage", { message: error.message })
    : t("pet.asrFailed");
}

/**
 * Produces a pet Agent send error message.
 *
 * @param error An unknown exception.
 * @param fallbackMessage The fallback text.
 * @returns Error text that can be shown in the pet task bubble.
 */
function toReadablePetAgentError(error: unknown, fallbackMessage: string): string {
  return error instanceof Error && error.message ? error.message : fallbackMessage;
}

/**
 * Strips a Markdown-formatted answer down to plain text for the pet bubble preview.
 *
 * Keeps the text content and basic line-break structure while removing all Markdown syntax decoration.
 * After expanding to full mode, AgentMessageContent is still used for full rendering.
 */
export function stripMarkdownForPetPreview(markdown: string): string {
  if (!markdown) return "";

  const stripped = markdown
    .replace(/^```[\s\S]*?^```/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "· ")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\|.*\|$/gm, (row) => row.replace(/\|/g, " ").replace(/[-:]+/g, "").trim())
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .trim();

  return stripped
    .split(/\n{2,}/)
    .map((paragraph) => paragraph
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" "))
    .filter(Boolean)
    .join("\n\n");
}
