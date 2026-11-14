/**
 * 小饭团演示的状态机：每一步的进入与推进条件、跳过、退出、出错与重试、三步都跳过，以及心跳上报的步骤。
 *
 * 这些规则都不依赖界面，所以按 reducer 直接断言；界面只负责发事件与画卡片。
 */
import { describe, expect, it } from "vitest";
import {
  demoGuideHeartbeatStep,
  demoGuideReducer,
  demoGuideStepNumberOf,
  type DemoGuideEvent,
  type DemoGuideState
} from "../collab-demo-guide-store.js";

const START = {
  projectId: "cloud-1",
  localProjectId: "local-1",
  memberUserId: "9001",
  memberName: "小饭团"
};

function started(): DemoGuideState {
  return demoGuideReducer(
    { ...({} as DemoGuideState), status: "ended", phase: "complete" },
    { type: "start", input: START }
  );
}

function run(state: DemoGuideState, events: DemoGuideEvent[]): DemoGuideState {
  return events.reduce((current, event) => demoGuideReducer(current, event), state);
}

describe("demo guide state machine", () => {
  it("starts on the member's task and opens the reader when the row is clicked", () => {
    const state = started();
    expect(state.status).toBe("active");
    expect(state.phase).toBe("task-row");
    expect(state.memberName).toBe("小饭团");
    expect(demoGuideReducer(state, { type: "task-opened" }).phase).toBe("reader");
  });

  it("prefills the composer when continuing the member's task, then waits for the agent", () => {
    const state = run(started(), [
      { type: "task-opened" },
      { type: "task-continued", prefill: "接着小饭团的清单，写一段邀请同事加入项目的话" }
    ]);
    expect(state.phase).toBe("compose");
    expect(state.prefill?.text).toBe("接着小饭团的清单，写一段邀请同事加入项目的话");
    const sent = demoGuideReducer(state, { type: "composer-sent" });
    expect(sent.phase).toBe("reply-waiting");
    expect(demoGuideReducer(sent, { type: "agent-settled" }).phase).toBe("reply-done");
  });

  it("only advances the second step once the assist result is back and the agent settled again", () => {
    const asked = run(started(), [
      { type: "task-opened" },
      { type: "task-continued", prefill: "接着小饭团的清单，写一段邀请同事加入项目的话" },
      { type: "composer-sent" },
      { type: "agent-settled" },
      { type: "next", prefill: "请小饭团看一下他电脑上的《项目协作常见问题》\n\n执行提示：直接调用 memmy-project assist ask，member 用 9001" }
    ]);
    expect(asked.phase).toBe("ask-compose");
    // 预填文案由界面按语言给出，同一句里带着执行提示，免得靠模型猜该做什么。
    expect(asked.prefill?.text).toContain("请小饭团看一下他电脑上的《项目协作常见问题》");
    expect(asked.prefill?.text).toContain("memmy-project assist ask");
    expect(asked.prefill?.text).toContain("9001");

    const waiting = demoGuideReducer(asked, { type: "composer-sent" });
    expect(waiting.phase).toBe("ask-waiting");
    // Agent 先回的那一句不算：结果还没回来就不能给「下一步」。
    expect(demoGuideReducer(waiting, { type: "agent-settled" }).phase).toBe("ask-waiting");
    const delivered = demoGuideReducer(waiting, { type: "assist-delivered" });
    expect(delivered.askDelivered).toBe(true);
    const done = demoGuideReducer(delivered, { type: "agent-settled" });
    expect(done.phase).toBe("ask-done");
    expect(done.done.ask).toBe(true);
  });

  it("walks the third step from settings to the finished assist", () => {
    const atSettings = run(started(), [
      { type: "task-opened" },
      { type: "task-continued" },
      { type: "composer-sent" },
      { type: "agent-settled" },
      { type: "next" },
      { type: "composer-sent" },
      { type: "assist-delivered" },
      { type: "agent-settled" },
      { type: "next" }
    ]);
    expect(atSettings.phase).toBe("settings-open");
    expect(demoGuideReducer(atSettings, { type: "settings-opened" }).phase).toBe("settings-assist");
    const waiting = demoGuideReducer(atSettings, { type: "receiving-on" });
    expect(waiting.phase).toBe("help-waiting");
    const dialog = demoGuideReducer(waiting, { type: "help-request-seen" });
    expect(dialog.phase).toBe("help-dialog");
    const running = demoGuideReducer(dialog, { type: "help-decided", allow: true });
    expect(running.phase).toBe("help-running");
    const finished = demoGuideReducer(running, { type: "help-finished" });
    expect(finished.phase).toBe("help-done");
    const complete = demoGuideReducer(finished, { type: "next" });
    expect(complete.status).toBe("complete");
    expect(complete.endReason).toBe("finished");
    expect(complete.done).toEqual({ task: true, ask: true, help: true });
  });

  it("treats a refusal in the authorization dialog as finishing the step", () => {
    const dialog = run(started(), [
      { type: "task-opened" },
      { type: "task-continued" },
      { type: "composer-sent" },
      { type: "agent-settled" },
      { type: "next" },
      { type: "composer-sent" },
      { type: "assist-delivered" },
      { type: "agent-settled" },
      { type: "next" },
      { type: "settings-opened" },
      { type: "receiving-on" },
      { type: "help-request-seen" }
    ]);
    const refused = demoGuideReducer(dialog, { type: "help-decided", allow: false });
    expect(refused.phase).toBe("help-rejected");
    const complete = demoGuideReducer(refused, { type: "next" });
    expect(complete.status).toBe("complete");
    expect(complete.done.help).toBe(false);
    expect(complete.done.task).toBe(true);
  });

  it("skips a single step without touching the others", () => {
    const skipped = demoGuideReducer(started(), { type: "skip" });
    expect(skipped.phase).toBe("ask-compose");
    expect(skipped.skipped.task).toBe(true);
    expect(skipped.done.task).toBe(false);
    const settings = demoGuideReducer(skipped, { type: "skip" });
    expect(settings.phase).toBe("settings-open");
    expect(settings.skipped.ask).toBe(true);
  });

  it("ends without the completion dialog when every step was skipped", () => {
    const state = run(started(), [
      { type: "skip" },
      { type: "composer-sent" },
      { type: "skip" },
      { type: "settings-opened" },
      { type: "skip" }
    ]);
    expect(state.status).toBe("ended");
    expect(state.endReason).toBe("skipped");
    expect(state.skipped).toEqual({ task: true, ask: true, help: true });
  });

  it("gives every step a way out of a failure", () => {
    const failed = demoGuideReducer(run(started(), [{ type: "task-opened" }]), { type: "fail", reason: "Agent 没有给出回复。" });
    expect(failed.error).toBe("Agent 没有给出回复。");
    expect(demoGuideReducer(failed, { type: "retry" }).error).toBeNull();
    expect(demoGuideReducer(failed, { type: "skip" }).phase).toBe("ask-compose");
  });

  it("stops at once when the cloud says the demo has ended", () => {
    const ended = demoGuideReducer(started(), { type: "cloud-ended" });
    expect(ended.status).toBe("ended");
    expect(ended.cloudEnded).toBe(true);
  });

  it("stops on exit before the walkthrough finished", () => {
    const exited = demoGuideReducer(started(), { type: "end", reason: "exited" });
    expect(exited.status).toBe("ended");
    expect(exited.endReason).toBe("exited");
  });

  it("maps every phase to a step number and a heartbeat step", () => {
    expect(demoGuideStepNumberOf("task-row")).toBe(1);
    expect(demoGuideStepNumberOf("reply-done")).toBe(1);
    expect(demoGuideStepNumberOf("ask-compose")).toBe(2);
    expect(demoGuideStepNumberOf("help-dialog")).toBe(3);
    expect(demoGuideStepNumberOf("complete")).toBe(3);
    expect(demoGuideHeartbeatStep("reader")).toBe("1");
    expect(demoGuideHeartbeatStep("ask-done")).toBe("2");
    expect(demoGuideHeartbeatStep("help-running")).toBe("3");
    expect(demoGuideHeartbeatStep("complete")).toBe("finish");
  });

  it("gives each prefill a new nonce so the composer is filled once per step", () => {
    const first = run(started(), [{ type: "task-opened" }, { type: "task-continued", prefill: "第一句" }]);
    expect(first.prefill?.nonce).toBe(1);
    const second = demoGuideReducer(
      { ...first, phase: "reply-done" },
      { type: "next", prefill: "第二句" }
    );
    expect(second.prefill).toMatchObject({ text: "第二句", nonce: 2 });
    // 跳过第一步也要把第二步那句话填上。
    const skipped = demoGuideReducer(started(), { type: "skip", prefill: "第二句" });
    expect(skipped.prefill?.text).toBe("第二句");
  });
});
