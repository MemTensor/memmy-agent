import { expect, it } from "vitest";
import { replayTranscriptToUiMessages } from "../../../src/entrypoints/frontend-bridge/transcript.js";

const question = { event: "message", text: "Choose a region", turn_id: "turn-1",
  agent_ui: { questionCard: { version: 1, requestId: "request-1", questions: [
    { id: "region", prompt: "Region?", options: [{ id: "sh", label: "Shanghai" }, { id: "bj", label: "Beijing" }] }
  ] } } };

it("replays an answered card in its original position without creating another user turn", () => {
  const messages = replayTranscriptToUiMessages([
    { event: "user", text: "Start", turn_id: "turn-1" }, question,
    { event: "agent_question_response", request_id: "request-1", turn_id: "turn-1",
      answers: [{ questionId: "region", selectedOptionIds: ["sh"] }] },
    { event: "message", text: "Finished", turn_id: "turn-1" },
    { event: "turn_end", turn_id: "turn-1" }
  ]);
  expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
  const card = messages.findIndex((message) => message.agent_ui);
  expect(card).toBeGreaterThanOrEqual(0);
  expect(messages[card]?.questionResponse).toMatchObject({ requestId: "request-1", answers: [{ questionId: "region", selectedOptionIds: ["sh"] }] });
  expect(messages.findIndex((message) => message.content === "Finished")).toBeGreaterThan(card);
  expect(messages[card]?.questionInterrupted).toBeUndefined();
});

it("marks an unanswered card from a closed turn as interrupted", () => {
  const messages = replayTranscriptToUiMessages([question, { event: "turn_end", turn_id: "turn-1" }]);
  expect(messages.find((message) => message.agent_ui)?.questionInterrupted).toBe(true);
});

it("expires only the orphan question when the gateway has no waiting request", () => {
  const lines = [{ event: "reasoning_delta", text: "Working", turn_id: "turn-1" }, question];
  const baseline = replayTranscriptToUiMessages(lines);
  const messages = replayTranscriptToUiMessages(lines, { isQuestionPending: () => false });
  expect(messages.find((message) => message.agent_ui)?.questionInterrupted).toBe(true);
  const ordinary = (items: Record<string, unknown>[]) => items.filter((message) => !message.agent_ui)
    .map(({ id: _generatedId, ...message }) => message);
  expect(ordinary(messages)).toEqual(ordinary(baseline));
});
