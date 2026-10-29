/** Composer follow-ups must stay in the queue until the server starts them. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemmyAgentWsEvent, WebuiQueuedMessage } from "../../api/memmy-agent-client.js";
import {
  agentReducer,
  initialAgentState,
  type AgentAction,
  type AgentChatMediaAttachment,
  type AgentState
} from "../agent-chat-slice.js";

const NOW = Date.parse("2026-10-12T09:00:00.000Z");
const CHAT = "chat-running";
const REQUEST = "11111111-1111-4111-8111-111111111111";
const NEXT_REQUEST = "22222222-2222-4222-8222-222222222222";
const CONTENT = "发2000字给我";
const MEDIA: AgentChatMediaAttachment[] = [{
  kind: "file",
  name: "notes.txt",
  path: "/uploads/notes.txt",
  url: "http://localhost/media/notes.txt"
}];

function event(state: AgentState, wire: MemmyAgentWsEvent): AgentState {
  return agentReducer(state, { type: "agent/wsEvent", event: wire });
}

function chatState(running = true): AgentState {
  let state = agentReducer(initialAgentState, { type: "agent/newChatCreated", chatId: CHAT });
  const messages: AgentState["messages"] = [
    { id: "original-user", role: "user", content: "发1500字给我", turnId: "turn-current" },
    { id: "original-answer", role: "assistant", content: "正在生成的正文", turnId: "turn-current" }
  ];
  state = { ...state, messages, messagesByChatId: { [CHAT]: messages }, queueRevisionByChatId: { [CHAT]: 0 } };
  return running ? event(state, {
    event: "run_status",
    chat_id: CHAT,
    status: "running",
    started_at: NOW / 1000,
    turn_id: "turn-current",
    source: { kind: "gui", channel: "websocket" }
  }) : state;
}

function submit(state: AgentState, input: {
  chatId?: string;
  clientRequestId?: string;
  content?: string;
  media?: AgentChatMediaAttachment[];
  focus?: boolean;
  queueIfBusy?: boolean;
} = {}): AgentState {
  const action: AgentAction = {
    type: "agent/userMessageQueued",
    chatId: input.chatId ?? CHAT,
    clientRequestId: input.clientRequestId ?? REQUEST,
    content: input.content ?? CONTENT,
    queueIfBusy: true,
    ...input
  };
  return agentReducer(state, action);
}

function queuedWire(clientRequestId = REQUEST, content = CONTENT): WebuiQueuedMessage {
  return {
    client_request_id: clientRequestId,
    text: content,
    media_urls: [],
    queued_at: new Date(NOW + 1).toISOString(),
    source: { kind: "gui", channel: "websocket" },
    queue_surface: "chat_composer"
  };
}

function acknowledge(state: AgentState, item = queuedWire(), revision = 1): AgentState {
  return event(state, {
    event: "message_queued",
    chat_id: CHAT,
    client_request_id: item.client_request_id,
    revision,
    item
  });
}

function accepted(state: AgentState, clientRequestId = REQUEST): AgentState {
  return event(state, { event: "message_accepted", chat_id: CHAT, client_request_id: clientRequestId });
}

function snapshot(state: AgentState, items: WebuiQueuedMessage[], started: WebuiQueuedMessage[] = [], revision = 0): AgentState {
  return event(state, {
    event: "message_queue_snapshot",
    chat_id: CHAT,
    revision,
    items,
    started_items: started
  });
}

function usersFor(state: AgentState, clientRequestId = REQUEST, chatId = CHAT) {
  const messages = chatId === state.currentChatId ? state.messages : state.messagesByChatId[chatId] ?? [];
  return messages.filter((message) => message.role === "user" && message.clientRequestId === clientRequestId);
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("composer queue projection", () => {
  it("shows a running-chat submission only in the pending queue before acknowledgement", () => {
    const base = chatState();
    const state: AgentState = {
      ...base,
      retryWaitStatusByChatId: { [CHAT]: {
        id: "retry-current", chatId: CHAT, turnId: "turn-current", text: "等待重试",
        isRunning: true, createdAt: NOW - 1000, updatedAt: NOW - 1000
      } },
      suppressAssistantStreamUntilTurnEndByChatId: { [CHAT]: true },
      deliveryUncertainByChatId: { [CHAT]: true }
    };
    const next = submit(state);

    expect(next.messages).toEqual(state.messages);
    expect(next.messagesByChatId[CHAT]).toEqual(state.messagesByChatId[CHAT]);
    expect(next.queuedMessagesByChatId[CHAT]).toEqual([expect.objectContaining({
      clientRequestId: REQUEST, content: CONTENT, queueSurface: "chat_composer", status: "sending",
      source: { kind: "gui", channel: "websocket" }
    })]);
    expect(next.optimisticSendingByChatId).toEqual(state.optimisticSendingByChatId);
    expect(next.optimisticTasksByChatId).toEqual(state.optimisticTasksByChatId);
    expect(next.retryWaitStatusByChatId).toEqual(state.retryWaitStatusByChatId);
    expect(next.suppressAssistantStreamUntilTurnEndByChatId).toEqual(state.suppressAssistantStreamUntilTurnEndByChatId);
    expect(next.deliveryUncertainByChatId).toEqual(state.deliveryUncertainByChatId);
    expect(next.activeTurnIdByChatId).toEqual(state.activeTurnIdByChatId);
    expect(next.runStartedAtByChatId).toEqual(state.runStartedAtByChatId);
    expect(next.isSending).toBe(true);
  });

  it("still displays an idle-chat submission immediately in the conversation", () => {
    const state = submit(chatState(false));
    expect(usersFor(state)).toEqual([expect.objectContaining({ content: CONTENT, clientRequestId: REQUEST })]);
    expect(state.queuedMessagesByChatId[CHAT]).toBeUndefined();
    expect(state.optimisticSendingByChatId[CHAT]).toBe(true);
    expect(state.isSending).toBe(true);
  });

  it("keeps legacy optimistic actions available for intentional promotion during a running turn", () => {
    const state = submit(chatState(), { queueIfBusy: false });
    expect(usersFor(state)).toHaveLength(1);
    expect(state.queuedMessagesByChatId[CHAT]).toBeUndefined();
  });

  it("does not insert the same pending request twice", () => {
    const first = submit(chatState());
    const second = submit(first);
    expect(second.queuedMessagesByChatId[CHAT]?.map((item) => item.clientRequestId)).toEqual([REQUEST]);
    expect(usersFor(second)).toHaveLength(0);
  });

  it("queues follow-ups while an assistant stream is open even without a running status", () => {
    const state = chatState(false);
    const messages = state.messages.map((message) => message.role === "assistant" ? { ...message, isStreaming: true } : message);
    const next = submit({ ...state, messages, messagesByChatId: { [CHAT]: messages } });
    expect(next.messages).toEqual(messages);
    expect(next.queuedMessagesByChatId[CHAT]?.[0]?.status).toBe("sending");
  });

  it("queues after existing waiting work while run-status updates are between turns", () => {
    const item = { ...queuedWire("earlier-request", "先执行这条"), queued_at: new Date(NOW - 1).toISOString() };
    const waiting = acknowledge(chatState(false), item);
    const next = submit(waiting);
    expect(next.queuedMessagesByChatId[CHAT]?.map((item) => item.clientRequestId)).toEqual(["earlier-request", REQUEST]);
    expect(next.messages).toEqual(waiting.messages);
    expect(next.optimisticSendingByChatId[CHAT]).toBeUndefined();
  });

  it("queues a second submission while the first idle-chat message is awaiting confirmation", () => {
    const first = submit(chatState(false));
    const second = submit(first, { clientRequestId: NEXT_REQUEST, content: "下一条" });
    expect(second.messages).toEqual(first.messages);
    expect(second.queuedMessagesByChatId[CHAT]?.map((item) => item.clientRequestId)).toEqual([NEXT_REQUEST]);
    expect(second.optimisticSendingByChatId[CHAT]).toBe(true);
  });

  it("confirms the pending row in place without touching the current conversation", () => {
    const pending = submit(chatState());
    const confirmed = acknowledge(pending);
    const duplicate = acknowledge(confirmed);
    expect(confirmed.queuedMessagesByChatId[CHAT]).toEqual([expect.objectContaining({ clientRequestId: REQUEST, status: "queued" })]);
    expect(confirmed.messages).toEqual(pending.messages);
    expect(confirmed.optimisticSendingByChatId[CHAT]).toBeUndefined();
    expect(duplicate.queuedMessagesByChatId[CHAT]).toEqual(confirmed.queuedMessagesByChatId[CHAT]);
    expect(usersFor(duplicate)).toHaveLength(0);
  });

  it("preserves an in-flight removal when the server repeats a confirmed queue item", () => {
    const confirmed = acknowledge(submit(chatState()));
    const removing = agentReducer(confirmed, { type: "agent/queueItemRemoveStarted", chatId: CHAT, clientRequestId: REQUEST });
    const duplicate = event(removing, {
      event: "message_queued", chat_id: CHAT, client_request_id: REQUEST, item: queuedWire()
    });
    expect(duplicate.queuedMessagesByChatId[CHAT]?.[0]?.status).toBe("removing");
  });

  it("moves an actually dequeued message into the conversation once while the preceding status remains busy", () => {
    const confirmed = acknowledge(submit(chatState()));
    const dequeued: MemmyAgentWsEvent = {
      event: "message_dequeued", chat_id: CHAT, client_request_id: REQUEST, revision: 2, item: queuedWire()
    };
    let next = event(confirmed, dequeued);
    next = event(next, dequeued);
    expect(next.queuedMessagesByChatId[CHAT]).toBeUndefined();
    expect(usersFor(next)).toEqual([expect.objectContaining({ content: CONTENT })]);
    expect(next.activeTurnIdByChatId[CHAT]).toBe("turn-current");
  });

  it("promotes an unconfirmed local queue row when the server accepts it immediately", () => {
    let state = accepted(submit(chatState()));
    state = accepted(state);
    expect(state.queuedMessagesByChatId[CHAT]).toBeUndefined();
    expect(usersFor(state)).toEqual([expect.objectContaining({ content: CONTENT, clientRequestId: REQUEST })]);
  });

  it("keeps a formally queued goal-inbox message waiting after its persistence acknowledgement", () => {
    const confirmed = acknowledge(submit(chatState()));
    const state = accepted(confirmed);
    expect(state.queuedMessagesByChatId[CHAT]).toEqual(confirmed.queuedMessagesByChatId[CHAT]);
    expect(state.messages).toEqual(confirmed.messages);
    expect(usersFor(state)).toHaveLength(0);
  });

  it("reconciles a canonical user before acceptance without leaving a queue row or duplicate", () => {
    let state = submit(chatState());
    const user: MemmyAgentWsEvent = {
      event: "user", chat_id: CHAT, client_request_id: REQUEST, turn_id: "turn-next", text: CONTENT
    };
    state = event(state, user);
    state = accepted(state);
    state = event(state, user);
    expect(state.queuedMessagesByChatId[CHAT]).toBeUndefined();
    expect(usersFor(state)).toEqual([expect.objectContaining({ content: CONTENT, turnId: "turn-next", clientRequestId: REQUEST })]);
    expect(state.messages.filter((message) => message.role === "user" && message.content === CONTENT)).toHaveLength(1);
  });

  it("reconciles a canonical user after immediate acceptance into the same message", () => {
    let state = accepted(submit(chatState()));
    state = event(state, {
      event: "user", chat_id: CHAT, client_request_id: REQUEST, turn_id: "turn-next", text: CONTENT
    });
    expect(state.queuedMessagesByChatId[CHAT]).toBeUndefined();
    expect(usersFor(state)).toEqual([expect.objectContaining({ turnId: "turn-next", clientRequestId: REQUEST })]);
    expect(state.messages.filter((message) => message.role === "user" && message.content === CONTENT)).toHaveLength(1);
  });

  it("preserves pending submissions across a snapshot produced before their queue acknowledgement", () => {
    const pending = submit(chatState());
    const state = snapshot(pending, []);
    expect(state.queuedMessagesByChatId[CHAT]).toEqual(pending.queuedMessagesByChatId[CHAT]);
    expect(state.messages).toEqual(pending.messages);
  });

  it("uses canonical waiting rows to confirm local pending rows without duplicating them", () => {
    const pending = submit(chatState());
    const state = snapshot(pending, [queuedWire()], [], 1);
    expect(state.queuedMessagesByChatId[CHAT]).toEqual([expect.objectContaining({ clientRequestId: REQUEST, status: "queued" })]);
    expect(state.messages).toEqual(pending.messages);
  });

  it("lets snapshot started items supersede both local pending and repeated waiting items", () => {
    const pending = submit(chatState());
    let state = snapshot(pending, [queuedWire()], [queuedWire()], 2);
    state = snapshot(state, [], [queuedWire()], 2);
    expect(state.queuedMessagesByChatId[CHAT]).toBeUndefined();
    expect(usersFor(state)).toHaveLength(1);
  });

  it("does not treat an accepted event as execution when a queue revision gap hides the queue acknowledgement", () => {
    const pending = submit(chatState());
    let state = acknowledge(pending, queuedWire(), 3);
    expect(state.queueDesyncedByChatId[CHAT]?.observedRevision).toBe(3);
    state = accepted(state);
    expect(state.queuedMessagesByChatId[CHAT]?.[0]?.status).toBe("queued");
    expect(state.messages).toEqual(pending.messages);
    state = snapshot(state, [queuedWire()], [], 3);
    expect(state.queueDesyncedByChatId[CHAT]).toBeUndefined();
    expect(state.queuedMessagesByChatId[CHAT]?.[0]?.status).toBe("queued");
    expect(usersFor(state)).toHaveLength(0);
  });

  it("removes only the rejected pending submission and leaves the running turn and other queue entries intact", () => {
    const first = submit(chatState());
    const pending = submit(first, { clientRequestId: NEXT_REQUEST, content: "保留这条" });
    const rejected = agentReducer(pending, {
      type: "agent/optimisticMessageRejected", chatId: CHAT, clientRequestId: REQUEST
    });
    expect(rejected.queuedMessagesByChatId[CHAT]?.map((item) => item.clientRequestId)).toEqual([NEXT_REQUEST]);
    expect(rejected.messages).toEqual(chatState().messages);
    expect(rejected.runStartedAtByChatId[CHAT]).toBe(NOW / 1000);
    expect(rejected.isSending).toBe(true);
  });

  it("accepts an immediately started submission during recovery of an unrelated queue revision gap", () => {
    let state = acknowledge(chatState(), queuedWire("other-request", "另一条"), 3);
    state = accepted(submit(state));
    expect(state.queueDesyncedByChatId[CHAT]?.observedRevision).toBe(3);
    expect(state.queuedMessagesByChatId[CHAT]).toBeUndefined();
    expect(usersFor(state)).toHaveLength(1);
    state = snapshot(state, [], [], 3);
    expect(usersFor(state)).toHaveLength(1);
  });

  it("continues the original assistant stream while a follow-up awaits queue confirmation", () => {
    let state = event(chatState(), {
      event: "delta", chat_id: CHAT, turn_id: "turn-current", text: "继续第一段"
    });
    const assistantId = state.messages.at(-1)?.id;
    state = submit(state);
    state = event(state, {
      event: "delta", chat_id: CHAT, turn_id: "turn-current", text: "，接着第二段"
    });
    expect(state.messages.at(-1)).toMatchObject({
      id: assistantId, role: "assistant", content: "继续第一段，接着第二段", isStreaming: true
    });
    state = event(state, { event: "stream_end", chat_id: CHAT, turn_id: "turn-current" });
    expect(state.messages.at(-1)).toMatchObject({ id: assistantId, content: "继续第一段，接着第二段" });
    state = event(state, { event: "turn_end", chat_id: CHAT, turn_id: "turn-current" });
    expect(state.messages.at(-1)).toMatchObject({ id: assistantId, isStreaming: false });
    expect(usersFor(state)).toHaveLength(0);
    expect(state.queuedMessagesByChatId[CHAT]?.[0]?.status).toBe("sending");
  });

  it("removes a pending row on a server rejection without removing the current user message", () => {
    const base = chatState();
    const state = event(submit(base), {
      event: "error", chat_id: CHAT, client_request_id: REQUEST,
      detail: "message_request_rejected", reason: "model_selection_unavailable"
    });
    expect(state.queuedMessagesByChatId[CHAT]).toBeUndefined();
    expect(state.messages).toEqual(base.messages);
    expect(state.isSending).toBe(true);
  });

  it("queues for a running background chat without changing the selected chat or its sending state", () => {
    let state = chatState(false);
    state = event(state, {
      event: "run_status", chat_id: "chat-background", status: "running", started_at: NOW / 1000,
      turn_id: "turn-background", source: { kind: "gui", channel: "websocket" }
    });
    const next = submit(state, { chatId: "chat-background", focus: false });
    expect(next.currentChatId).toBe(CHAT);
    expect(next.currentSessionKey).toBe(state.currentSessionKey);
    expect(next.chatSelectionEpoch).toBe(state.chatSelectionEpoch);
    expect(next.messages).toEqual(state.messages);
    expect(next.isSending).toBe(state.isSending);
    expect(next.messagesByChatId["chat-background"]).toBeUndefined();
    expect(next.queuedMessagesByChatId["chat-background"]?.[0]).toMatchObject({ clientRequestId: REQUEST, status: "sending" });
  });

  it("keeps attachment-only follow-ups in the queue and transfers their media on dequeue", () => {
    const pending = submit(chatState(), { content: "", media: MEDIA });
    expect(pending.queuedMessagesByChatId[CHAT]?.[0]).toMatchObject({ content: "", media: MEDIA, status: "sending" });
    expect(usersFor(pending)).toHaveLength(0);
    const item = { ...queuedWire(REQUEST, ""), media_urls: MEDIA };
    const confirmed = acknowledge(pending, item);
    const dequeued = event(confirmed, {
      event: "message_dequeued", chat_id: CHAT, client_request_id: REQUEST, revision: 2, item
    });
    expect(dequeued.queuedMessagesByChatId[CHAT]).toBeUndefined();
    expect(usersFor(dequeued)).toEqual([expect.objectContaining({ content: "", media: MEDIA })]);
  });
});
