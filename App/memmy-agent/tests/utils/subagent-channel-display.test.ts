import { describe, expect, it } from "vitest";
import {
  scrubSubagentAnnounceBody,
  scrubSubagentMessagesForChannel,
} from "../../src/utils/subagent-channel-display.js";

describe("subagent channel display", () => {
  it("keeps the header and result only", () => {
    const raw = "[Subagent 'Phase1' failed]\n\nTask: Collect GitHub stats.\n\nResult:\ngh CLI missing.\n\nSummarize this naturally for the user. Keep it brief.";
    const out = scrubSubagentAnnounceBody(raw);
    expect(out).toBe("[Subagent 'Phase1' failed]\n\ngh CLI missing.");
    expect(out).not.toContain("Task:");
    expect(out).not.toContain("Summarize");
  });

  it("mutates matching rows only", () => {
    const messages: Record<string, any>[] = [
      { role: "assistant", content: "hi" },
      {
        role: "assistant",
        content: "[Subagent 'x' completed successfully]\n\nTask: t\n\nResult:\nr\n\nSummarize this naturally",
        injectedEvent: "subagentResult",
      },
    ];
    scrubSubagentMessagesForChannel(messages);
    expect(messages[0].content).toBe("hi");
    expect(messages[1].content).not.toContain("Task:");
    expect(messages[1].content).toContain("[Subagent 'x' completed successfully]");
    expect(messages[1].content).toContain("r");
  });

  it("normalizes CRLF before result markers", () => {
    const out = scrubSubagentAnnounceBody("[Subagent 'z' failed]\r\n\r\nTask: x\r\n\r\nResult:\r\none line\r\n\r\nSummarize this naturally");
    expect(out).not.toContain("Task:");
    expect(out).toMatch(/^\[Subagent 'z' failed]/);
    expect(out).toContain("one line");
  });

  it("truncates very long results", () => {
    const body = "x".repeat(900);
    const long = scrubSubagentAnnounceBody(`[Subagent 'z' failed]\n\nTask: t\n\nResult:\n${body}\n\nSummarize this naturally`);
    expect(long).toMatch(/…$/);
    expect(long.length).toBeLessThan(body.length);
    expect(long).not.toContain(body);
  });
});
