// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import {
  AgentQuestionCard,
  AgentQuestionActiveRequestContext,
  AgentQuestionDockContext,
  hasPendingAgentQuestion,
  pendingAgentQuestion,
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
  it("places the pending form in the composer dock and returns an accepted summary to the transcript", async () => {
    const dock = document.createElement("div");
    document.body.append(dock);
    const onSubmit = vi.fn(async () => true);
    await act(async () => root.render(<I18nProvider language="zh-CN"><AgentQuestionDockContext.Provider value={dock}>
      <AgentQuestionCard card={card} onSubmit={onSubmit} />
    </AgentQuestionDockContext.Provider></I18nProvider>));
    expect(container.querySelector(".agent-confirmation-card")).toBeNull();
    expect(dock.querySelector(".agent-confirmation-card")).not.toBeNull();
    await act(async () => [...dock.querySelectorAll("button")].find((button) => button.textContent?.includes("已全部上传，继续"))!.click());
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(dock.children).toHaveLength(0);
    expect(container.querySelector(".agent-question-answer summary")?.textContent).toBe("已收到回答");
    expect(container.querySelector(".agent-question-answer__details")?.textContent).toContain("已全部上传，继续");
    expect(container.querySelector(".agent-question-answer")?.hasAttribute("open")).toBe(false);
    dock.remove();
  });

  it("opens an answered process question by default and lets the user collapse it", async () => {
    const response: AgentQuestionResponse = {
      requestId: card.requestId,
      answers: [{ questionId: "uploads", selectedOptionIds: ["done"] }],
    };
    await act(async () => root.render(<I18nProvider language="zh-CN">
      <AgentQuestionCard card={card} response={response} processView />
    </I18nProvider>));
    const details = container.querySelector<HTMLDetailsElement>(".agent-question-answer--process")!;
    expect(details.open).toBe(true);
    expect(details.querySelector("summary")?.textContent).toBe("继续前请确认");
    expect(details.textContent).toContain("已全部上传，继续");

    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(false);
  });

  it("changes a research requirements question from waiting to its completed title", async () => {
    const researchCard = { ...card, title: "确认研究需求" };
    const response: AgentQuestionResponse = {
      requestId: researchCard.requestId,
      answers: [{ questionId: "uploads", selectedOptionIds: ["done"] }],
    };
    const renderCard = (answer?: AgentQuestionResponse) => (
      <I18nProvider language="zh-CN">
        <AgentQuestionActiveRequestContext.Provider value={researchCard.requestId}>
          <AgentQuestionCard card={researchCard} response={answer} processView />
        </AgentQuestionActiveRequestContext.Provider>
      </I18nProvider>
    );
    await act(async () => root.render(renderCard()));
    expect(container.querySelector(".agent-question-answer--review")?.textContent).toBe("等待确认研究需求");

    await act(async () => root.render(renderCard(response)));
    expect(container.querySelector(".agent-question-answer summary")?.textContent).toBe("确认研究需求");
    expect(container.querySelector(".agent-question-answer__details")?.textContent).toContain("已全部上传，继续");
  });

  it("keeps only the ask step after its turn was interrupted", async () => {
    await act(async () => root.render(<I18nProvider language="zh-CN">
      <AgentQuestionCard card={card} interrupted processView />
    </I18nProvider>));
    expect(container.textContent).toContain("继续前请确认");
    expect(container.textContent).not.toContain("等待继续前请确认");
    expect(container.textContent).not.toContain(card.questions[0]!.prompt);
    expect(container.querySelector(".agent-confirmation-card")).toBeNull();
    expect(hasPendingAgentQuestion([{ role: "assistant", content: "", turnId: "turn-1", agentUi: { questionCard: card }, questionInterrupted: true }], "turn-1")).toBe(false);
  });
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

  it("treats a pending native question as waiting until its persisted response arrives", () => {
    const asked = { role: "assistant", content: "", turnId: "turn-1", agentUi: { questionCard: card } };
    expect(hasPendingAgentQuestion([asked], "turn-1")).toBe(true);
    expect(hasPendingAgentQuestion([asked], null)).toBe(false);
    expect(hasPendingAgentQuestion([asked], "turn-2")).toBe(false);
    const stale = { ...asked, turnId: "turn-old", agentUi: { questionCard: { ...card, requestId: "old" } } };
    expect(pendingAgentQuestion([asked, stale], "turn-1")).toEqual(card);
    const response = { requestId: card.requestId, answers: [{ questionId: "uploads", selectedOptionIds: ["done"] }] };
    expect(hasPendingAgentQuestion([asked, { role: "user", content: serializeAgentQuestionResponse(card, response).content }], "turn-1")).toBe(false);
    expect(hasPendingAgentQuestion([{ ...asked, questionResponse: response }], "turn-1")).toBe(false);
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
    expect(container.textContent).not.toContain("继续前请确认");
    expect(container.textContent).not.toContain("单选");
    await act(async () => option.click());

    expect(onSubmit).toHaveBeenCalledWith({
      requestId: "question-1",
      answers: [{ questionId: "uploads", selectedOptionIds: ["done"] }],
    });
  });

  it("allows selecting several categories when the question permits multiple answers", async () => {
    const onSubmit = vi.fn(async () => true);
    const multipleCard: AgentQuestionCardPayload = {
      ...card,
      questions: [{
        ...card.questions[0]!,
        prompt: "想添加哪些分类？",
        options: [{ id: "pets", label: "宠物" }, { id: "fitness", label: "健身" }],
        allowMultiple: true,
      }],
    };
    await act(async () => root.render(<I18nProvider language="zh-CN">
      <AgentQuestionCard card={multipleCard} onSubmit={onSubmit} />
    </I18nProvider>));
    expect(container.textContent).not.toContain("可多选");
    const pets = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("宠物"))!;
    const fitness = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("健身"))!;
    await act(async () => pets.click());
    await act(async () => fitness.click());
    expect(pets.getAttribute("aria-pressed")).toBe("true");
    expect(fitness.getAttribute("aria-pressed")).toBe("true");
    const submit = container.querySelector<HTMLButtonElement>(".agent-question-card__continue")!;
    expect(submit.textContent).toBe("确认并继续");
    await act(async () => submit.click());
    expect(onSubmit).toHaveBeenCalledWith({
      requestId: "question-1",
      answers: [{ questionId: "uploads", selectedOptionIds: ["pets", "fitness"] }],
    });
  });

  it("submits a custom single-choice answer through a labeled action", async () => {
    const onSubmit = vi.fn(async () => true);
    await act(async () => root.render(<I18nProvider language="zh-CN">
      <AgentQuestionCard card={card} onSubmit={onSubmit} />
    </I18nProvider>));
    const input = container.querySelector<HTMLInputElement>(".agent-question-card__other input")!;
    expect(container.querySelector(".agent-question-card__other button")).toBeNull();
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "宠物和健身");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = container.querySelector<HTMLButtonElement>(".agent-question-card__continue")!;
    expect(confirm.textContent).toBe("确认并继续");
    await act(async () => confirm.click());
    expect(onSubmit).toHaveBeenCalledWith({
      requestId: "question-1",
      answers: [{ questionId: "uploads", selectedOptionIds: [], otherText: "宠物和健身" }],
    });
  });

  it("shows one question at a time and keeps answers while paging", async () => {
    const onSubmit = vi.fn(async () => true);
    const twoQuestionCard: AgentQuestionCardPayload = {
      ...card,
      questions: [
        { ...card.questions[0]!, prompt: "想加哪些分类？", allowMultiple: true },
        {
          id: "kind",
          prompt: "这个分类用于哪里？",
          options: [{ id: "expense", label: "支出" }, { id: "income", label: "收入" }],
          allowMultiple: false,
          allowOther: false,
        },
      ],
    };
    await act(async () => root.render(<I18nProvider language="zh-CN">
      <AgentQuestionCard card={twoQuestionCard} onSubmit={onSubmit} />
    </I18nProvider>));
    expect(container.textContent).toContain("想加哪些分类？");
    expect(container.textContent).not.toContain("这个分类用于哪里？");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("继续上传文件"))!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-question-card__continue")!.click());
    expect(container.textContent).toContain("这个分类用于哪里？");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "上一题")!.click());
    expect(container.querySelector(".agent-question-card__option[aria-pressed='true']")?.textContent).toContain("继续上传文件");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "下一题")!.click());
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("支出"))!.click());
    expect(onSubmit).toHaveBeenCalledWith({
      requestId: "question-1",
      answers: [
        { questionId: "uploads", selectedOptionIds: ["more"] },
        { questionId: "kind", selectedOptionIds: ["expense"] },
      ],
    });
  });

  it("records a skipped question as unanswered in the process", async () => {
    const onSubmit = vi.fn(async () => true);
    await act(async () => root.render(<I18nProvider language="zh-CN">
      <AgentQuestionCard card={card} onSubmit={onSubmit} processView />
    </I18nProvider>));
    const skip = [...container.querySelectorAll("button")].find((button) => button.textContent === "跳过")!;
    await act(async () => skip.click());
    expect(onSubmit).toHaveBeenCalledWith({
      requestId: "question-1",
      answers: [{ questionId: "uploads", selectedOptionIds: [] }],
    });
    expect(container.querySelector(".agent-question-answer summary")?.textContent).toBe("继续前请确认");
    expect(container.querySelector(".agent-question-answer__details")?.textContent).toContain("还有其他文件需要上传吗？未回答");
  });

  it("closes the card by submitting skipped answers for every question", async () => {
    const onSubmit = vi.fn(async () => true);
    const closeCard: AgentQuestionCardPayload = {
      ...card,
      questions: [card.questions[0]!, {
        id: "kind",
        prompt: "这个分类用于哪里？",
        options: [{ id: "expense", label: "支出" }, { id: "income", label: "收入" }],
        allowMultiple: false,
        allowOther: false,
      }],
    };
    await act(async () => root.render(<I18nProvider language="zh-CN">
      <AgentQuestionCard card={closeCard} onSubmit={onSubmit} processView />
    </I18nProvider>));
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-question-card__close")!.click());
    expect(onSubmit).toHaveBeenCalledWith({
      requestId: "question-1",
      answers: [
        { questionId: "uploads", selectedOptionIds: [] },
        { questionId: "kind", selectedOptionIds: [] },
      ],
    });
    expect(container.querySelector(".agent-question-answer summary")?.textContent).toBe("继续前请确认");
    expect(container.querySelectorAll(".agent-question-answer__details dd")).toHaveLength(2);
    expect([...container.querySelectorAll(".agent-question-answer__details dd")].map((answer) => answer.textContent)).toEqual(["未回答", "未回答"]);
  });

  it("skips the current question and advances to the next one", async () => {
    const onSubmit = vi.fn(async () => true);
    const twoQuestionCard: AgentQuestionCardPayload = {
      ...card,
      questions: [card.questions[0]!, {
        id: "kind",
        prompt: "这个分类用于哪里？",
        options: [{ id: "expense", label: "支出" }, { id: "income", label: "收入" }],
        allowMultiple: false,
        allowOther: false,
      }],
    };
    await act(async () => root.render(<I18nProvider language="zh-CN">
      <AgentQuestionCard card={twoQuestionCard} onSubmit={onSubmit} />
    </I18nProvider>));
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "跳过")!.click());
    expect(container.textContent).toContain("这个分类用于哪里？");
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("支出"))!.click());
    expect(onSubmit).toHaveBeenCalledWith({
      requestId: "question-1",
      answers: [
        { questionId: "uploads", selectedOptionIds: [] },
        { questionId: "kind", selectedOptionIds: ["expense"] },
      ],
    });
  });

  it("keeps option details available as a tooltip without filling every row", async () => {
    const describedCard: AgentQuestionCardPayload = {
      ...card,
      questions: [{ ...card.questions[0]!, options: [
        { id: "more", label: "继续上传", description: "可以稍后再补充" },
        { id: "done", label: "已完成", description: "直接继续任务" },
      ] }],
    };
    await act(async () => root.render(<I18nProvider language="zh-CN">
      <AgentQuestionCard card={describedCard} />
    </I18nProvider>));
    expect(container.textContent).not.toContain("可以稍后再补充");
    expect(container.querySelector(".agent-question-card__option")?.getAttribute("title")).toBe("可以稍后再补充");
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
    expect(container.textContent).toContain("已收到回答");
    expect(container.querySelector(".agent-confirmation-card")).toBeNull();
    expect(container.textContent).not.toContain("提交回答");
  });
});
