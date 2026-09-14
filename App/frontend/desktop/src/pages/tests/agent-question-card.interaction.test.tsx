// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import {
  AgentQuestionCard,
  readAgentQuestionCard,
  readAgentQuestionResponse,
  serializeAgentQuestionResponse,
  visibleAgentQuestionResponseContent,
  type AgentQuestionCardPayload,
  type AgentQuestionResponse,
} from "../agent-question-card.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: AgentQuestionCardPayload = {
  version: 1,
  requestId: "question-1",
  title: "继续前请确认",
  questions: [{
    id: "uploads",
    prompt: "还有其他文件需要上传吗？",
    options: [
      { id: "more", label: "继续上传文件" },
      { id: "done", label: "已全部上传，继续" },
    ],
    allowMultiple: false,
    allowOther: true,
  }],
};

describe("AgentQuestionCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("reads the structured agent UI payload", () => {
    expect(readAgentQuestionCard({ questionCard: card })).toEqual(card);
    expect(readAgentQuestionCard({ questionCard: { version: 1, requestId: "", questions: [] } })).toBeNull();
  });

  it("submits a clicked option as a structured response", async () => {
    const onSubmit = vi.fn(async () => true);
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <AgentQuestionCard card={card} onSubmit={onSubmit} />
      </I18nProvider>
    ));
    const option = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("已全部上传，继续"))!;
    const submit = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("提交回答"))!;

    expect(submit.disabled).toBe(true);
    act(() => option.click());
    expect(option.getAttribute("aria-pressed")).toBe("true");
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());

    expect(onSubmit).toHaveBeenCalledWith({
      requestId: "question-1",
      answers: [{ questionId: "uploads", selectedOptionIds: ["done"] }],
    });
  });

  it("serializes an answer for the model while hiding the transport marker", () => {
    const response: AgentQuestionResponse = {
      requestId: "question-1",
      answers: [{ questionId: "uploads", selectedOptionIds: ["done"] }],
    };

    const serialized = serializeAgentQuestionResponse(card, response);

    expect(serialized.displayContent).toContain("已全部上传，继续");
    expect(serialized.content).toContain("memmy-question-response:");
    expect(readAgentQuestionResponse(serialized.content)).toEqual(response);
    expect(visibleAgentQuestionResponseContent(serialized.content)).toBe(serialized.displayContent);
  });

  it("renders an answered card as read-only", async () => {
    const response: AgentQuestionResponse = {
      requestId: "question-1",
      answers: [{ questionId: "uploads", selectedOptionIds: ["done"] }],
    };
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <AgentQuestionCard card={card} response={response} />
      </I18nProvider>
    ));

    expect(container.textContent).toContain("已全部上传，继续");
    expect(container.textContent).toContain("已回答");
    expect(container.textContent).not.toContain("提交回答");
  });
});
