import { describe, expect, it } from "vitest";
import {
  OpenMemCloudClient,
  type OpenMemFetch,
  openMemAddMessageFromTurnComplete,
  openMemFeedbackFromFeedback
} from "../../src/index.js";

describe("OpenMem cloud REST client contract", () => {
  it("maps Memmy lifecycle DTOs to the documented OpenMem memories REST operations", async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }> = [];
    const fetchImpl: OpenMemFetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        authorization: headers.get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const client = new OpenMemCloudClient({
      endpoint: "https://memos.memtensor.cn/api/openmem/v1/",
      apiKey: "cloud-key",
      fetchImpl
    });

    const addMessage = openMemAddMessageFromTurnComplete({
      userId: "user-1",
      conversationId: "session-1",
      turnId: "turn-1",
      agentId: "memmy-agent",
      appId: "memmy-app",
      tags: ["agent"],
      allowKnowledgebaseIds: ["kb-local"],
      request: {
        sessionId: "session-1",
        episodeId: "episode-1",
        query: "remember this",
        answer: "stored as an L1 trace",
        tags: ["memory"],
        toolCalls: [{ id: "call-shell", name: "shell", input: { cmd: "npm test" } }],
        toolResults: [{ tool_call_id: "call-shell", content: "tests passed" }],
        sourceMemoryIds: ["mem-1"]
      }
    });
    expect(addMessage).toMatchObject({
      user_id: "user-1",
      conversation_id: "session-1",
      agent_id: "memmy-agent",
      app_id: "memmy-app",
      tags: ["agent", "memory"],
      allow_knowledgebase_ids: ["kb-local"],
      info: {
        memory_layer: "L1",
        turn_id: "turn-1",
        episode_id: "episode-1",
        source_memory_ids: ["mem-1"]
      }
    });
    expect(addMessage.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(addMessage.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{
        id: "call-shell",
        type: "function",
        function: {
          name: "shell",
          arguments: "{\"cmd\":\"npm test\"}"
        }
      }]
    });
    expect(addMessage.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call-shell",
      content: "tests passed"
    });

    const feedback = openMemFeedbackFromFeedback({
      userId: "user-1",
      conversationId: "session-1",
      agentId: "memmy-agent",
      appId: "memmy-app",
      feedbackTime: "2026-05-30T08:00:00.000Z",
      allowKnowledgebaseIds: ["kb-1"],
      request: {
        sessionId: "session-1",
        episodeId: "episode-1",
        channel: "explicit",
        polarity: "negative",
        magnitude: 0.9,
        rationale: "The memory should prefer SQLite locally.",
        l1MemoryId: "mem-1"
      }
    });
    expect(feedback).toMatchObject({
      user_id: "user-1",
      conversation_id: "session-1",
      feedback_content: "The memory should prefer SQLite locally.",
      agent_id: "memmy-agent",
      app_id: "memmy-app",
      feedback_time: "2026-05-30T08:00:00.000Z",
      allow_knowledgebase_ids: ["kb-1"],
      info: {
        memory_layer: "feedback",
        episode_id: "episode-1",
        l1_memory_id: "mem-1",
        channel: "explicit",
        polarity: "negative",
        magnitude: 0.9
      }
    });

    await client.addMessage(addMessage);
    await client.addFeedback(feedback);

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/openmem/v1/add/message",
      "/api/openmem/v1/add/feedback"
    ]);
    expect(calls.map((call) => call.authorization)).toEqual([
      "Token cloud-key",
      "Token cloud-key"
    ]);
    expect(calls[0]!.body).toMatchObject({ user_id: "user-1", messages: addMessage.messages });
    expect(calls[1]!.body).toMatchObject({ feedback_content: "The memory should prefer SQLite locally." });
  });
});
