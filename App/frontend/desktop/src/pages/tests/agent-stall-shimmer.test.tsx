// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STALL_SHIMMER_CLASS, AGENT_STALL_SHIMMER_DELAY_MS, agentOutputSignature, findLastOutputLine, useStalledOutputShimmer } from "../agent-stall-shimmer.js";

function render(html: string): HTMLDivElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

describe("findLastOutputLine", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("picks the last paragraph of the running answer", () => {
    const container = render(`
      <div class="agent-message-content"><p class="agent-message-content__p">first</p><p class="agent-message-content__p">second</p></div>
    `);
    expect(findLastOutputLine(container)?.textContent).toBe("second");
  });

  it("treats a folded thought as its header line", () => {
    // Folded: the body is not rendered at all, so the label is the last line.
    const container = render(`
      <div class="agent-message-content"><p class="agent-message-content__p">earlier answer text</p></div>
      <div class="agent-activity-segment"><button class="agent-narration-block__toggle" aria-expanded="false"><span class="agent-narration-block__label">简短思考</span></button></div>
    `);
    expect(findLastOutputLine(container)?.textContent).toBe("简短思考");
  });

  it("uses the summary of a closed tool group, not the rows hidden inside it", () => {
    const container = render(`
      <details class="agent-activity-tool-group-details">
        <summary><p class="agent-activity-segment__label"><span>Ran 3 commands</span></p></summary>
        <div><p class="agent-activity-timeline-item__line">hidden row</p></div>
      </details>
    `);
    expect(findLastOutputLine(container)?.textContent).toBe("Ran 3 commands");
  });

  it("uses the inner rows once that group is open", () => {
    const container = render(`
      <details class="agent-activity-tool-group-details" open>
        <summary><p class="agent-activity-segment__label"><span>Ran 3 commands</span></p></summary>
        <div><p class="agent-activity-timeline-item__line">last row</p></div>
      </details>
    `);
    expect(findLastOutputLine(container)?.textContent).toBe("last row");
  });

  it("never lights up the user's own message or an earlier answer", () => {
    const container = render(`
      <div class="agent-message-content"><p class="agent-message-content__p">previous answer</p></div>
      <div class="agent-user-turn"><p class="agent-message-content__p">question</p></div>
    `);
    expect(findLastOutputLine(container)).toBeNull();
  });
});

describe("agentOutputSignature", () => {
  it("changes when text streams in and when a tool row is added", () => {
    const base = [{ id: "a", role: "assistant" as const, content: "hi" }];
    const streamed = [{ ...base[0]!, content: "hi there" }];
    const withTool = [{ ...base[0]!, toolEvents: [{} as never] }];
    expect(agentOutputSignature(streamed)).not.toBe(agentOutputSignature(base));
    expect(agentOutputSignature(withTool)).not.toBe(agentOutputSignature(base));
    expect(agentOutputSignature([...base])).toBe(agentOutputSignature(base));
  });
});

describe("useStalledOutputShimmer", () => {
  let host: HTMLDivElement;
  let root: Root;

  function Thread(props: { active: boolean; text: string }) {
    const ref = useRef<HTMLDivElement | null>(null);
    useStalledOutputShimmer(ref, props.active, props.text);
    return <div ref={ref}><div className="agent-message-content"><p className="agent-message-content__p">{props.text}</p></div></div>;
  }

  const line = () => host.querySelector(".agent-message-content__p")!;

  beforeEach(() => {
    vi.useFakeTimers();
    // happy-dom does no layout; give every line one 200px-wide row to measure.
    const row = { top: 0, bottom: 20, left: 0, right: 200, width: 200, height: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([row] as unknown as DOMRectList);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(row);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("measures the sweep to the line it lights", () => {
    act(() => root.render(<Thread active text="正在生成" />));
    act(() => vi.advanceTimersByTime(AGENT_STALL_SHIMMER_DELAY_MS));
    expect(line().style.getPropertyValue("--agent-stall-to")).toBe("200px");
    expect(line().style.getPropertyValue("--agent-stall-height")).toBe("20px");
  });

  it("starts after 3 quiet seconds and resets when new text arrives", () => {
    act(() => root.render(<Thread active text="正在生成" />));
    act(() => vi.advanceTimersByTime(AGENT_STALL_SHIMMER_DELAY_MS - 1));
    expect(line().classList.contains(AGENT_STALL_SHIMMER_CLASS)).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    expect(line().classList.contains(AGENT_STALL_SHIMMER_CLASS)).toBe(true);

    act(() => root.render(<Thread active text="正在生成更多" />));
    expect(line().classList.contains(AGENT_STALL_SHIMMER_CLASS)).toBe(false);
    act(() => vi.advanceTimersByTime(AGENT_STALL_SHIMMER_DELAY_MS));
    expect(line().classList.contains(AGENT_STALL_SHIMMER_CLASS)).toBe(true);
  });

  it("stops as soon as the turn finishes", () => {
    act(() => root.render(<Thread active text="正在生成" />));
    act(() => vi.advanceTimersByTime(AGENT_STALL_SHIMMER_DELAY_MS));
    act(() => root.render(<Thread active={false} text="正在生成" />));
    expect(line().classList.contains(AGENT_STALL_SHIMMER_CLASS)).toBe(false);
  });
});
