import { describe, expect, it } from "vitest";
import { computeWebuiMessageDigest } from "../../../src/integrations/channels/websocket.js";

const base = {
  chatId: "chat-1",
  content: "hello",
  mediaPaths: [] as string[],
  language: null,
  target: null,
  modelPreset: "fast",
  queueSurface: "chat_composer" as const,
  turnAdmission: "queue" as const,
  expectedTurnId: null,
};

describe("webui message digest", () => {
  it("distinguishes recording consent and scope while retaining thinking and interrupt identity", () => {
    const request = { ...base, thinkingEnabled: true, thinkingLevel: "medium", interruptPendingTurnId: "turn-1" };
    const taskRecording = { title: "Demo", applications: ["editor"], consent: true };
    const recorded = computeWebuiMessageDigest({ ...request, taskRecording });
    expect(recorded).not.toBe(computeWebuiMessageDigest(request));
    expect(recorded).not.toBe(computeWebuiMessageDigest({ ...request, taskRecording: { ...taskRecording, applications: ["browser"] } }));
    expect(recorded).not.toBe(computeWebuiMessageDigest({ ...request, taskRecording, thinkingLevel: "high" }));
    expect(recorded).not.toBe(computeWebuiMessageDigest({ ...request, taskRecording, interruptPendingTurnId: "turn-2" }));
    expect(recorded).toBe(computeWebuiMessageDigest({ ...request, taskRecording: { ...taskRecording } }));
  });

  it("changes when thinking fields differ for the same text", () => {
    const none = computeWebuiMessageDigest({
      ...base,
      thinkingEnabled: false,
    });
    const medium = computeWebuiMessageDigest({
      ...base,
      thinkingEnabled: true,
      thinkingLevel: "medium",
    });
    const high = computeWebuiMessageDigest({
      ...base,
      thinkingEnabled: true,
      thinkingLevel: "high",
    });

    expect(none).not.toBe(medium);
    expect(medium).not.toBe(high);
    expect(computeWebuiMessageDigest({
      ...base,
      thinkingEnabled: true,
      thinkingLevel: "medium",
    })).toBe(medium);
  });
});
