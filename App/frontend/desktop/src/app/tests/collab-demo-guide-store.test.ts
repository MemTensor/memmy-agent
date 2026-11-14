/**
 * 小饭团演示的状态机：每一步的进入与推进条件、跳过、退出、出错与重试、四步都跳过，以及心跳上报的步骤。
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

const ASK_SENTENCE = "请小饭团看一下他电脑上的《项目协作常见问题》，告诉我成员请我协助时，我这边会发生什么";

function raw(): DemoGuideState {
  return { ...({} as DemoGuideState), status: "ended", phase: "complete" };
}

/** 云端刚开始演示：停在那张「加入了项目」的提示窗上，还没有蒙版。 */
function joined(): DemoGuideState {
  return demoGuideReducer(raw(), { type: "start", input: START });
}

/** 点了「开始体验」：第一步的蒙版。 */
function started(): DemoGuideState {
  return demoGuideReducer(joined(), { type: "joined-confirmed" });
}

function run(state: DemoGuideState, events: DemoGuideEvent[]): DemoGuideState {
  return events.reduce((current, event) => demoGuideReducer(current, event), state);
}

/** 走过第一步：在小饭团的任务里接着写完那句邀请的话。 */
const FIRST_STEP: DemoGuideEvent[] = [
  { type: "task-opened" },
  { type: "task-continued", prefill: "接着小饭团的清单，写一段邀请同事加入项目的话" },
  { type: "composer-sent" },
  { type: "agent-settled" }
];

/** 走到「关联已有任务」这一步。 */
function atAssociate(): DemoGuideState {
  return run(started(), [...FIRST_STEP, { type: "next" }]);
}

/** 走到第三步（请成员协助）的输入框。 */
function atAskCompose(): DemoGuideState {
  return run(atAssociate(), [{ type: "next", prefill: ASK_SENTENCE }]);
}

/** 走到第三步的结果回到对话。 */
function atAskDone(): DemoGuideState {
  return run(atAskCompose(), [{ type: "composer-sent" }, { type: "assist-delivered" }, { type: "agent-settled" }]);
}

/** 走到第四步的项目设置。 */
function atSettings(): DemoGuideState {
  return run(atAskDone(), [{ type: "next" }]);
}

/** 走到第四步的授权弹窗。 */
function atHelpDialog(): DemoGuideState {
  return run(atSettings(), [{ type: "settings-opened" }, { type: "receiving-on" }, { type: "help-request-seen" }]);
}

describe("demo guide state machine", () => {
  it("starts on the join notice and only opens the first step once it is dismissed", () => {
    const state = joined();
    expect(state.status).toBe("active");
    expect(state.phase).toBe("joined");
    // 云端还没说演示开始时不会有这张提示窗：这里只认 `start`。
    expect(state.memberName).toBe("小饭团");
    const first = demoGuideReducer(state, { type: "joined-confirmed" });
    expect(first.phase).toBe("task-row");
    expect(demoGuideReducer(first, { type: "task-opened" }).phase).toBe("reader");
    // 提示窗本身不是一步：跳不了，也不会被当成第一步跳过。
    expect(demoGuideReducer(state, { type: "skip" })).toBe(state);
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

  it("sends the person to the link-a-task step before asking a member for help", () => {
    const associated = atAssociate();
    expect(associated.phase).toBe("associate");
    expect(associated.done.task).toBe(true);
    // 这一步的按钮在看板上，做人自己点：点完直接去请成员协助，并把那句话填进输入框。
    const asking = demoGuideReducer(associated, { type: "next", prefill: ASK_SENTENCE });
    expect(asking.phase).toBe("ask-compose");
    expect(asking.prefill?.text).toBe(ASK_SENTENCE);
  });

  it("only advances the asking step once the assist result is back and the agent settled again", () => {
    const waiting = demoGuideReducer(atAskCompose(), { type: "composer-sent" });
    expect(waiting.phase).toBe("ask-waiting");
    // Agent 先回的那一句不算：结果还没回来就不能给「下一步」。
    expect(demoGuideReducer(waiting, { type: "agent-settled" }).phase).toBe("ask-waiting");
    const delivered = demoGuideReducer(waiting, { type: "assist-delivered" });
    expect(delivered.askDelivered).toBe(true);
    const done = demoGuideReducer(delivered, { type: "agent-settled" });
    expect(done.phase).toBe("ask-done");
    expect(done.done.ask).toBe(true);
  });

  it("walks the last step from settings to the finished assist", () => {
    const settings = atSettings();
    expect(settings.phase).toBe("settings-open");
    expect(demoGuideReducer(settings, { type: "settings-opened" }).phase).toBe("settings-assist");
    const waiting = demoGuideReducer(settings, { type: "receiving-on" });
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
    expect(complete.done).toEqual({ task: true, associate: true, ask: true, help: true });
  });

  it("treats a refusal in the authorization dialog as finishing the step", () => {
    const refused = demoGuideReducer(atHelpDialog(), { type: "help-decided", allow: false });
    expect(refused.phase).toBe("help-rejected");
    const complete = demoGuideReducer(refused, { type: "next" });
    expect(complete.status).toBe("complete");
    expect(complete.done.help).toBe(false);
    expect(complete.done.task).toBe(true);
  });

  it("skips a single step without touching the others", () => {
    // 跳过第一步：接着去关联任务，不预填任何话。
    const skippedTask = demoGuideReducer(started(), { type: "skip" });
    expect(skippedTask.phase).toBe("associate");
    expect(skippedTask.skipped.task).toBe(true);
    expect(skippedTask.done.task).toBe(false);
    expect(skippedTask.prefill).toBeNull();

    // 跳过关联任务：直接去请成员协助，那句话跟着填上。
    const skippedAssociate = demoGuideReducer(skippedTask, { type: "skip", prefill: ASK_SENTENCE });
    expect(skippedAssociate.phase).toBe("ask-compose");
    expect(skippedAssociate.skipped.associate).toBe(true);
    expect(skippedAssociate.done.associate).toBe(false);
    expect(skippedAssociate.prefill?.text).toBe(ASK_SENTENCE);

    const settings = demoGuideReducer(skippedAssociate, { type: "skip" });
    expect(settings.phase).toBe("settings-open");
    expect(settings.skipped.ask).toBe(true);
  });

  it("ends without the completion dialog when every step was skipped", () => {
    const state = run(started(), [
      { type: "skip" },
      { type: "skip" },
      { type: "composer-sent" },
      { type: "skip" },
      { type: "settings-opened" },
      { type: "skip" }
    ]);
    expect(state.status).toBe("ended");
    expect(state.endReason).toBe("skipped");
    expect(state.skipped).toEqual({ task: true, associate: true, ask: true, help: true });
  });

  it("still offers the completion dialog when only the link-a-task step was skipped", () => {
    const state = run(started(), [
      ...FIRST_STEP,
      { type: "next" },
      { type: "skip" },
      { type: "composer-sent" },
      { type: "assist-delivered" },
      { type: "agent-settled" },
      { type: "next" },
      { type: "settings-opened" },
      { type: "receiving-on" },
      { type: "help-request-seen" },
      { type: "help-decided", allow: true },
      { type: "help-finished" },
      { type: "next" }
    ]);
    expect(state.status).toBe("complete");
    expect(state.done.associate).toBe(false);
    expect(state.skipped.associate).toBe(true);
  });

  it("gives every step a way out of a failure", () => {
    const failed = demoGuideReducer(run(started(), [{ type: "task-opened" }]), { type: "fail", reason: "Agent 没有给出回复。" });
    expect(failed.error).toBe("Agent 没有给出回复。");
    expect(demoGuideReducer(failed, { type: "retry" }).error).toBeNull();
    expect(demoGuideReducer(failed, { type: "skip" }).phase).toBe("associate");
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

  it("maps every phase to a step number and a heartbeat step the cloud accepts", () => {
    expect(demoGuideStepNumberOf("joined")).toBe(1);
    expect(demoGuideStepNumberOf("task-row")).toBe(1);
    expect(demoGuideStepNumberOf("reply-done")).toBe(1);
    expect(demoGuideStepNumberOf("associate")).toBe(2);
    expect(demoGuideStepNumberOf("ask-compose")).toBe(3);
    expect(demoGuideStepNumberOf("help-dialog")).toBe(4);
    expect(demoGuideStepNumberOf("complete")).toBe(4);
    // 云端只接受 1 / 2 / 3 / finish：四步要压到这三个值上，绝不发 4。
    expect(demoGuideHeartbeatStep("joined")).toBe("1");
    expect(demoGuideHeartbeatStep("reader")).toBe("1");
    expect(demoGuideHeartbeatStep("associate")).toBe("1");
    expect(demoGuideHeartbeatStep("ask-done")).toBe("2");
    expect(demoGuideHeartbeatStep("settings-open")).toBe("3");
    expect(demoGuideHeartbeatStep("help-running")).toBe("3");
    expect(demoGuideHeartbeatStep("complete")).toBe("finish");
  });

  it("starts on the create-project step with nothing to skip", () => {
    const before = demoGuideReducer(raw(), { type: "start-before-project" });
    expect(before.status).toBe("active");
    expect(before.phase).toBe("create-project");
    // 还没有云端项目：心跳与结束演示都无处可发。
    expect(before.projectId).toBeNull();
    expect(before.memberUserId).toBeNull();
    // 这一步跳不了：不建项目就没有后面的演示；取消这一步不是「退出」，直接回到空闲。
    expect(demoGuideReducer(before, { type: "skip" }).phase).toBe("create-project");
    expect(demoGuideReducer(before, { type: "end", reason: "exited" }).status).toBe("ended");
  });

  it("shows the join notice right after the project is created, before the first step", () => {
    const before = demoGuideReducer(raw(), { type: "start-before-project" });
    const started = demoGuideReducer(before, { type: "start", input: START });
    expect(started.phase).toBe("joined");
    expect(started.projectId).toBe("cloud-1");
    expect(started.memberName).toBe("小饭团");
    // 演示成员回到第一步用的还是同一个昵称。
    expect(demoGuideReducer(started, { type: "joined-confirmed" }).phase).toBe("task-row");
  });

  it("says a failure once instead of on every poll", () => {
    const failed = demoGuideReducer(started(), { type: "fail", reason: "协助请求没有发出去。" });
    // 轮询每拍都会读到同一个失败结果：同一个原因不换新对象，界面不会跟着重画。
    expect(demoGuideReducer(failed, { type: "fail", reason: "协助请求没有发出去。" })).toBe(failed);
    expect(demoGuideReducer(failed, { type: "fail", reason: "另一个原因" }).error).toBe("另一个原因");
  });

  it("gives each prefill a new nonce so the composer is filled once per step", () => {
    const first = run(started(), [{ type: "task-opened" }, { type: "task-continued", prefill: "第一句" }]);
    expect(first.prefill?.nonce).toBe(1);
    // 去关联任务这一步不换文案（输入框里的那句原样留着），回来请成员协助时才换下一句。
    const atAssociateStep = demoGuideReducer({ ...first, phase: "reply-done" }, { type: "next" });
    expect(atAssociateStep.prefill?.nonce).toBe(1);
    const asked = demoGuideReducer(atAssociateStep, { type: "next", prefill: "第二句" });
    expect(asked.prefill).toMatchObject({ text: "第二句", nonce: 2 });
  });
});
