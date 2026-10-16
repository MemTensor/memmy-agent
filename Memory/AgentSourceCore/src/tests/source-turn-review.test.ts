import { describe, expect, it } from "vitest";
import {
  buildSourceTurnRequest,
  readCursorSourceTurn,
  readOpenclawSourceTurn,
  readOpencodeSourceTurn,
  sourceTurnSkipBlocksWatermark,
  type CursorVscdbSource,
  type OpenclawTranscriptSource,
  type OpencodeSource,
  type SourceTurn
} from "../index.js";

const t = "2099-01-01T10:00:00.000Z";

describe("review regressions for native source turns", () => {
  it("lets cancelled skips commit a watermark and keeps incomplete skips retryable", () => {
    expect(sourceTurnSkipBlocksWatermark("turn_cancelled")).toBe(false);
    expect(sourceTurnSkipBlocksWatermark("turn_incomplete")).toBe(true);
    expect(sourceTurnSkipBlocksWatermark("turn_content_incomplete")).toBe(true);
    expect(sourceTurnSkipBlocksWatermark("source_turn_content_conflict")).toBe(true);
  });

  it("uses the disk profile for both hook and scan requests", () => {
    const turn: SourceTurn = {
      source: "opencode",
      conversationId: "ses1",
      turnId: "u",
      profileId: "build",
      startedAt: t,
      completedAt: t,
      sequence: 0,
      completionEvidence: "assistant_completed:a",
      query: "Implement the configuration reader.",
      answer: "Done.",
      status: "succeeded",
      toolCalls: [],
      toolResults: []
    };
    expect(buildSourceTurnRequest(turn, "hook").sourceTurn.profileId).toBe("build");
    expect(buildSourceTurnRequest(turn, "agent_source_scan").sourceTurn.profileId).toBe("build");
    expect(buildSourceTurnRequest(turn, "hook", "work").sourceTurn.profileId).toBe("work");
  });

  it("keeps a generating Cursor composer with progress text pending", async () => {
    const bubbles: Record<string, Record<string, unknown>> = {
      u: { type: 1, text: "Implement the configuration reader.", createdAt: t, requestId: "req" },
      a: { type: 2, text: "I will inspect the files first", createdAt: t },
      tool: { type: 2, createdAt: t, toolFormerData: { toolCallId: "call1", name: "read", status: "running" } }
    };
    const source: CursorVscdbSource = {
      mainComposerIds: () => ["c"],
      composerData: () => ({
        status: "generating",
        fullConversationHeadersOnly: Object.entries(bubbles).map(([bubbleId, bubble]) => ({
          bubbleId,
          type: bubble.type
        }))
      }),
      bubble: (_composerId, id) => bubbles[id]
    };
    const result = await readCursorSourceTurn(source, { conversationId: "c", requestId: "req" });
    expect(result.turn).toBeNull();
    expect(result.reason).toBe("turn_incomplete");
  });

  it("keeps a previous Cursor turn pending after the next user message arrives", async () => {
    const bubbles: Record<string, Record<string, unknown>> = {
      u: { type: 1, text: "Implement the configuration reader.", createdAt: t, requestId: "req" },
      a: { type: 2, text: "I will inspect the files first", createdAt: t },
      tool: { type: 2, createdAt: t, toolFormerData: { toolCallId: "call1", name: "read", status: "running" } },
      u2: { type: 1, text: "Are you still inspecting?", createdAt: "2099-01-01T10:01:00.000Z", requestId: "req2" }
    };
    const source: CursorVscdbSource = {
      mainComposerIds: () => ["c"],
      composerData: () => ({
        status: "generating",
        fullConversationHeadersOnly: Object.entries(bubbles).map(([bubbleId, bubble]) => ({
          bubbleId,
          type: bubble.type
        }))
      }),
      bubble: (_composerId, id) => bubbles[id]
    };
    const result = await readCursorSourceTurn(source, { conversationId: "c", requestId: "req" });
    expect(result.turn).toBeNull();
    expect(result.reason).toBe("turn_incomplete");
  });

  it("still captures a finished Cursor turn after a later user message", async () => {
    const bubbles: Record<string, Record<string, unknown>> = {
      u: { type: 1, text: "Implement the configuration reader.", createdAt: t, requestId: "req" },
      a: { type: 2, text: "Configuration inspected.", createdAt: t },
      u2: { type: 1, text: "Thanks.", createdAt: "2099-01-01T10:01:00.000Z", requestId: "req2" }
    };
    const source: CursorVscdbSource = {
      mainComposerIds: () => ["c"],
      composerData: () => ({
        status: "generating",
        fullConversationHeadersOnly: Object.entries(bubbles).map(([bubbleId, bubble]) => ({
          bubbleId,
          type: bubble.type
        }))
      }),
      bubble: (_composerId, id) => bubbles[id]
    };
    const result = await readCursorSourceTurn(source, { conversationId: "c", requestId: "req" });
    expect(result.turn?.answer).toBe("Configuration inspected.");
  });

  it("keeps an OpenCode turn on the user message agent after session.agent changes", async () => {
    const messages = () => [
      { id: "u", data: { role: "user", agent: "build", time: { created: 4_070_944_800_000 } } },
      {
        id: "a",
        data: {
          role: "assistant",
          parentID: "u",
          finish: "stop",
          time: { created: 4_070_944_801_000, completed: 4_070_944_802_000 }
        }
      }
    ];
    const parts = (id: string) => [{
      id: `p${id}`,
      data: { type: "text", text: id === "u" ? "Implement the configuration reader." : "Done." }
    }];
    const hook = await readOpencodeSourceTurn({
      sessions: () => [{ id: "ses1", parentId: null, directory: null, agent: "build" }],
      messages,
      parts
    }, { conversationId: "ses1", turnId: "u" });
    const scan = await readOpencodeSourceTurn({
      sessions: () => [{ id: "ses1", parentId: null, directory: null, agent: "plan" }],
      messages,
      parts
    }, { conversationId: "ses1", turnId: "u" });
    expect(hook.turn?.profileId).toBe("build");
    expect(scan.turn?.profileId).toBe("build");
    expect(buildSourceTurnRequest(hook.turn!, "hook").sourceTurn.profileId).toBe("build");
    expect(buildSourceTurnRequest(scan.turn!, "agent_source_scan").sourceTurn.profileId).toBe("build");
  });

  it("falls back from a missing user agent to the assistant agent, not session.agent", async () => {
    const messages = () => [
      { id: "u", data: { role: "user", time: { created: 4_070_944_800_000 } } },
      {
        id: "a",
        data: {
          role: "assistant",
          agent: "build",
          parentID: "u",
          finish: "stop",
          time: { created: 4_070_944_801_000, completed: 4_070_944_802_000 }
        }
      }
    ];
    const parts = (id: string) => [{
      id: `p${id}`,
      data: { type: "text", text: id === "u" ? "Implement the configuration reader." : "Done." }
    }];
    const fromAssistant = await readOpencodeSourceTurn({
      sessions: () => [{ id: "ses1", parentId: null, directory: null, agent: "plan" }],
      messages,
      parts
    }, { conversationId: "ses1", turnId: "u" });
    const unresolved = await readOpencodeSourceTurn({
      sessions: () => [{ id: "ses1", parentId: null, directory: null, agent: "plan" }],
      messages: () => [
        { id: "u", data: { role: "user", time: { created: 4_070_944_800_000 } } },
        {
          id: "a",
          data: {
            role: "assistant",
            parentID: "u",
            finish: "stop",
            time: { created: 4_070_944_801_000, completed: 4_070_944_802_000 }
          }
        }
      ],
      parts
    }, { conversationId: "ses1", turnId: "u" });
    expect(fromAssistant.turn?.profileId).toBe("build");
    expect(unresolved.turn).toBeNull();
    expect(unresolved.reason).toBe("identity_unresolved");
  });

  it("does not complete an OpenCode assistant that only has time.created", async () => {
    const source: OpencodeSource = {
      sessions: () => [{ id: "ses1", parentId: null, directory: null, agent: "build" }],
      messages: () => [
        { id: "u", data: { role: "user", time: { created: 4_070_944_800_000 } } },
        { id: "a", data: { role: "assistant", parentID: "u", time: { created: 4_070_944_801_000 } } }
      ],
      parts: (id) => [{ id: `p${id}`, data: { type: "text", text: id === "u" ? "Implement the configuration reader." : "I will inspect the files first" } }]
    };
    const result = await readOpencodeSourceTurn(source, { conversationId: "ses1", turnId: "u" });
    expect(result.turn).toBeNull();
    expect(result.reason).toBe("turn_incomplete");
  });

  it("keeps a completed OpenCode tool-calls step pending until finish=stop", async () => {
    const parts = (id: string) => {
      if (id === "u") return [{ id: "pu", data: { type: "text", text: "Inspect the configuration file." } }];
      if (id === "step") {
        return [
          { id: "ps", data: { type: "text", text: "I will inspect the files first" } },
          { id: "pt", data: { type: "tool", callID: "call1", tool: "read", state: { status: "completed", input: { path: "config" }, output: "ok" } } }
        ];
      }
      return [{ id: "pf", data: { type: "text", text: "Configuration inspected." } }];
    };
    const early = await readOpencodeSourceTurn({
      sessions: () => [{ id: "ses1", parentId: null, directory: null, agent: "build" }],
      messages: () => [
        { id: "u", data: { role: "user", agent: "build", time: { created: 4_070_944_800_000 } } },
        {
          id: "step",
          data: {
            role: "assistant",
            parentID: "u",
            finish: "tool-calls",
            time: { created: 4_070_944_801_000, completed: 4_070_944_801_500 }
          }
        }
      ],
      parts
    }, { conversationId: "ses1", turnId: "u" });
    expect(early.turn).toBeNull();
    expect(early.reason).toBe("turn_incomplete");
    const finalTurn = await readOpencodeSourceTurn({
      sessions: () => [{ id: "ses1", parentId: null, directory: null, agent: "plan" }],
      messages: () => [
        { id: "u", data: { role: "user", agent: "build", time: { created: 4_070_944_800_000 } } },
        {
          id: "step",
          data: {
            role: "assistant",
            parentID: "u",
            finish: "tool-calls",
            time: { created: 4_070_944_801_000, completed: 4_070_944_801_500 }
          }
        },
        {
          id: "final",
          data: {
            role: "assistant",
            parentID: "u",
            finish: "stop",
            time: { created: 4_070_944_802_000, completed: 4_070_944_802_500 }
          }
        }
      ],
      parts
    }, { conversationId: "ses1", turnId: "u" });
    expect(finalTurn.turn?.profileId).toBe("build");
    expect(finalTurn.turn?.answer).toContain("Configuration inspected.");
    expect(finalTurn.turn?.completionEvidence).toBe("assistant_completed:final");
  });

  it("keeps OpenCode unknown and stop-with-host-tools pending until a terminal assistant", async () => {
    const query = "Inspect the configuration and report the verified result.";
    const progress = "I have started inspecting the configuration.";
    const answer = "The configuration was verified and the result is now documented.";
    const parts = (id: string, tools: boolean) => {
      if (id === "u") return [{ id: "pu", data: { type: "text", text: query } }];
      if (id === "a") {
        return [
          { id: "pa", data: { type: "text", text: progress } },
          ...(tools ? [{ id: "pt", data: { type: "tool", callID: "call1", tool: "read", state: { status: "completed", input: { path: "config" }, output: "configuration data" } } }] : [])
        ];
      }
      return [{ id: "pf", data: { type: "text", text: answer } }];
    };
    const earlyUnknown = await readOpencodeSourceTurn({
      sessions: () => [{ id: "ses1", parentId: null, directory: null, agent: "build" }],
      messages: () => [
        { id: "u", data: { role: "user", agent: "build", time: { created: 4_070_944_800_000 } } },
        { id: "a", data: { role: "assistant", agent: "build", parentID: "u", finish: "unknown", time: { created: 4_070_944_801_000, completed: 4_070_944_802_000 } } }
      ],
      parts: (id) => parts(id, false)
    }, { conversationId: "ses1", turnId: "u" });
    const earlyStopTools = await readOpencodeSourceTurn({
      sessions: () => [{ id: "ses1", parentId: null, directory: null, agent: "build" }],
      messages: () => [
        { id: "u", data: { role: "user", agent: "build", time: { created: 4_070_944_800_000 } } },
        { id: "a", data: { role: "assistant", agent: "build", parentID: "u", finish: "stop", time: { created: 4_070_944_801_000, completed: 4_070_944_802_000 } } }
      ],
      parts: (id) => parts(id, true)
    }, { conversationId: "ses1", turnId: "u" });
    const finalTurn = await readOpencodeSourceTurn({
      sessions: () => [{ id: "ses1", parentId: null, directory: null, agent: "build" }],
      messages: () => [
        { id: "u", data: { role: "user", agent: "build", time: { created: 4_070_944_800_000 } } },
        { id: "a", data: { role: "assistant", agent: "build", parentID: "u", finish: "unknown", time: { created: 4_070_944_801_000, completed: 4_070_944_802_000 } } },
        { id: "final", data: { role: "assistant", agent: "build", parentID: "u", finish: "stop", time: { created: 4_070_944_803_000, completed: 4_070_944_804_000 } } }
      ],
      parts: (id) => parts(id, false)
    }, { conversationId: "ses1", turnId: "u" });
    const providerExecuted = await readOpencodeSourceTurn({
      sessions: () => [{ id: "ses1", parentId: null, directory: null, agent: "build" }],
      messages: () => [
        { id: "u", data: { role: "user", agent: "build", time: { created: 4_070_944_800_000 } } },
        { id: "a", data: { role: "assistant", agent: "build", parentID: "u", finish: "stop", time: { created: 4_070_944_801_000, completed: 4_070_944_802_000 } } }
      ],
      parts: (id) => id === "u"
        ? [{ id: "pu", data: { type: "text", text: query } }]
        : [
          { id: "pa", data: { type: "text", text: answer } },
          { id: "pt", data: { type: "tool", callID: "call1", tool: "read", metadata: { providerExecuted: true }, state: { status: "completed", input: { path: "config" }, output: "ok" } } }
        ]
    }, { conversationId: "ses1", turnId: "u" });
    expect(earlyUnknown.turn).toBeNull();
    expect(earlyStopTools.turn).toBeNull();
    expect(finalTurn.turn?.answer).toContain(answer);
    expect(providerExecuted.turn?.answer).toContain(answer);
  });

  it.each(OPENCODE_TERMINAL_CASES)("applies the OpenCode native finish contract for $name", async (entry) => {
    const result = await readOpencodeSourceTurn(opencodeTerminalSource(entry), {
      conversationId: entry.name,
      turnId: "u"
    });
    if (!entry.expectCapture) {
      expect(result.turn).toBeNull();
      return;
    }
    expect(result.turn).toMatchObject({
      source: "opencode",
      conversationId: entry.name,
      turnId: "u",
      profileId: "build",
      completionEvidence: entry.aborted ? "assistant_aborted:a" : "assistant_completed:a"
    });
    if (entry.tool === "structured") {
      expect(result.turn?.answer).toBe("");
      expect(result.turn?.toolCalls).toEqual([
        expect.objectContaining({ id: "call1", name: "StructuredOutput", input: STRUCTURED_OUTPUT })
      ]);
      expect(result.turn?.toolResults).toEqual([
        expect.objectContaining({ id: "call1", output: "Structured output captured successfully." })
      ]);
    }
  });

  it("hides OpenCode messages from revert.messageID onward", async () => {
    const source: OpencodeSource = {
      sessions: () => [{ id: "ses1", parentId: null, directory: null, agent: "build", revertMessageId: "u" }],
      messages: () => [
        { id: "u", data: { role: "user", time: { created: 4_070_944_800_000 } } },
        { id: "a", data: { role: "assistant", parentID: "u", time: { created: 4_070_944_801_000, completed: 4_070_944_802_000 } } }
      ],
      parts: (id) => [{ id: `p${id}`, data: { type: "text", text: id === "u" ? "Implement the configuration reader." : "Done." } }]
    };
    const result = await readOpencodeSourceTurn(source, { conversationId: "ses1", turnId: "u" });
    expect(result.turn).toBeNull();
  });

  it("pairs OpenClaw role=toolResult messages by tool_call_id", async () => {
    const source: OpenclawTranscriptSource = {
      windows: () => [{ sessionId: "w", sessionKey: "agent:main:main" }],
      events: () => [
        row(1, "user", [{ type: "text", text: "Inspect the configuration file and report the result." }]),
        row(2, "assistant", [{ type: "toolCall", id: "call1", name: "bash", arguments: { command: "cat config" } }]),
        row(3, "toolResult", [{ type: "text", text: "configuration result" }], { tool_call_id: "call1", isError: false }),
        row(4, "assistant", [{ type: "text", text: "Configuration inspected." }], { terminal: true })
      ]
    };
    const result = await readOpenclawSourceTurn(source, { sessionId: "w", runId: "r1" });
    expect(result.turn?.profileId).toBe("main");
    expect(result.turn?.toolCalls).toHaveLength(1);
    expect(result.turn?.toolResults).toHaveLength(1);
    expect(result.turn?.toolCalls[0]?.output).toBe("configuration result");
  });
});

const STRUCTURED_OUTPUT = { verified: true, result: "The configuration was verified and documented." };
const OPENCODE_QUERY = "Inspect the configuration and report the verified result.";
interface OpencodeTerminalCase {
  name: string;
  finish?: string;
  tool?: "host" | "provider" | "orphan" | "structured" | "structured-running";
  structured?: boolean;
  aborted?: boolean;
  noAgent?: boolean;
  expectCapture: boolean;
}
const OPENCODE_TERMINAL_CASES: readonly OpencodeTerminalCase[] = [
  { name: "plain-final", finish: "stop", expectCapture: true },
  { name: "unknown-interstep", finish: "unknown", expectCapture: false },
  { name: "host-tool-stop", finish: "stop", tool: "host", expectCapture: false },
  { name: "host-tool-calls", finish: "tool-calls", tool: "host", expectCapture: false },
  { name: "provider-tool-final", finish: "stop", tool: "provider", expectCapture: true },
  { name: "orphan-interrupted", finish: "stop", tool: "orphan", expectCapture: true },
  { name: "aborted-tool-only", tool: "host", aborted: true, expectCapture: true },
  { name: "unresolved-profile", finish: "stop", noAgent: true, expectCapture: false },
  { name: "structured-tool-running", finish: "tool-calls", tool: "structured-running", expectCapture: false },
  { name: "structured-result-not-persisted", finish: "tool-calls", tool: "structured", expectCapture: false },
  { name: "structured-final-tool-calls", finish: "tool-calls", tool: "structured", structured: true, expectCapture: true },
  { name: "structured-final-stop", finish: "stop", tool: "structured", structured: true, expectCapture: true },
  { name: "structured-final-unknown", finish: "unknown", tool: "structured", structured: true, expectCapture: true }
];

function opencodeTerminalSource(entry: OpencodeTerminalCase): OpencodeSource {
  const rows = opencodeTerminalRows(entry);
  return {
    sessions: () => [{ id: entry.name, parentId: null, directory: null, agent: "mutable-session-agent" }],
    messages: () => rows.messages,
    parts: (messageId) => rows.parts.filter((part) => part.messageId === messageId)
  };
}

function opencodeTerminalRows(entry: OpencodeTerminalCase): {
  messages: Array<{ id: string; data: Record<string, unknown> }>;
  parts: Array<{ id: string; messageId: string; data: Record<string, unknown> }>;
} {
  const agent = entry.noAgent ? {} : { agent: "build" };
  const structuredTool = entry.tool === "structured" || entry.tool === "structured-running";
  return {
    messages: [
      {
        id: "u",
        data: {
          role: "user",
          ...agent,
          time: { created: 4_070_944_800_000 },
          ...(structuredTool ? { format: { type: "json_schema", schema: { type: "object" } } } : {})
        }
      },
      {
        id: "a",
        data: {
          role: "assistant",
          parentID: "u",
          ...agent,
          ...("finish" in entry ? { finish: entry.finish } : {}),
          ...("structured" in entry && entry.structured ? { structured: STRUCTURED_OUTPUT } : {}),
          ...("aborted" in entry && entry.aborted
            ? { error: { name: "MessageAbortedError", data: { message: "The operation was aborted." } } }
            : {}),
          time: { created: 4_070_944_801_000, completed: 4_070_944_802_000 }
        }
      }
    ],
    parts: [
      { id: "pu", messageId: "u", data: { type: "text", text: OPENCODE_QUERY } },
      ...(!entry.tool
        ? [{ id: "pa", messageId: "a", data: { type: "text", text: STRUCTURED_OUTPUT.result } }]
        : [{
          id: "pt",
          messageId: "a",
          data: {
            type: "tool",
            callID: "call1",
            tool: structuredTool ? "StructuredOutput" : "read",
            ...(entry.tool === "provider" ? { metadata: { providerExecuted: true } } : {}),
            state: entry.tool === "orphan"
              ? {
                status: "error",
                input: { path: "config" },
                error: "Tool execution interrupted",
                metadata: { interrupted: true }
              }
              : entry.tool === "structured-running"
                ? { status: "running", input: STRUCTURED_OUTPUT, time: { start: 4_070_944_801_000 } }
                : {
                  status: "completed",
                  input: structuredTool ? STRUCTURED_OUTPUT : { path: "config" },
                  output: structuredTool ? "Structured output captured successfully." : "Configuration verified.",
                  metadata: structuredTool ? { valid: true } : {}
                }
          }
        }])
    ]
  };
}

function row(
  seq: number,
  role: string,
  content: unknown,
  extra: Record<string, unknown> = {}
): { seq: number; event: Record<string, unknown> } {
  return {
    seq,
    event: {
      id: `e${seq}`,
      timestamp: t,
      type: "message",
      message: {
        role,
        content,
        __openclaw: { runId: "r1", ...(extra.terminal ? { runTerminal: true } : {}) },
        ...extra
      }
    }
  };
}
