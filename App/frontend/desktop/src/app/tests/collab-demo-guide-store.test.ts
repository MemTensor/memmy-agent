/**
 * 小饭团演示的状态机：看板导览的推进、体验段三步的进入与推进条件、跳过、退出、出错与重试、
 * 三步都跳过，以及心跳上报的步骤。
 *
 * 这些规则都不依赖界面，所以按 reducer 直接断言；界面只负责发事件与画卡片。
 */
import { describe, expect, it } from "vitest";
import {
  DEMO_GUIDE_BEFORE_PROJECT_PHASES,
  DEMO_GUIDE_TOUR_PHASES,
  demoGuideHeartbeatStep,
  demoGuideIsBeforeProjectPhase,
  demoGuideIsTourPhase,
  demoGuideNextBeforeProjectPhase,
  demoGuideNextTourPhase,
  demoGuideReducer,
  demoGuideStartsExperience,
  demoGuideStepNumberOf,
  demoGuideTourIndex,
  type DemoGuideEvent,
  type DemoGuideState
} from "../collab-demo-guide-store.js";

const START = {
  projectId: "cloud-1",
  localProjectId: "local-1",
  memberUserId: "9001",
  memberName: "小饭团"
};

const ASK_SENTENCE = "请小饭团查一下上次分享会一共来了多少人";

function raw(): DemoGuideState {
  return { ...({} as DemoGuideState), status: "ended", phase: "complete" };
}

/** 云端刚开始演示：停在那张「加入了项目」的提示窗上，还没有蒙版。 */
function joined(): DemoGuideState {
  return demoGuideReducer(raw(), { type: "start", input: START });
}

/** 看板导览的第一步：任务列表。 */
function touring(): DemoGuideState {
  return demoGuideReducer(joined(), { type: "joined-confirmed" });
}

/** 导览走完、点了〔开始协作〕：体验第一步的蒙版。 */
function started(): DemoGuideState {
  // 导览五步一路点「下一步」：最后一步的按钮是「开始协作」，点完就是体验第一步。
  // 「关联会话」那一站要等扫描出结果才放行：这里替弹窗报一个数。
  return throughTour(touring());
}

/** 一路点过看板导览：进到体验段的第一站就停。 */
function throughTour(state: DemoGuideState): DemoGuideState {
  let current = state;
  while (demoGuideIsTourPhase(current.phase)) {
    if (current.phase === "tour-associate-pick") current = demoGuideReducer(current, { type: "scan-settled", count: 12 });
    current = demoGuideReducer(current, { type: "next" });
  }
  return current;
}

function run(state: DemoGuideState, events: DemoGuideEvent[]): DemoGuideState {
  return events.reduce((current, event) => demoGuideReducer(current, event), state);
}

/** 走过第一步：在小饭团的任务里接着写完那封分享会的通知。 */
const FIRST_STEP: DemoGuideEvent[] = [
  { type: "task-opened" },
  { type: "task-continued", prefill: "接着小饭团的安排，写一段分享会的通知" },
  { type: "composer-sent" },
  { type: "agent-settled" }
];

/** 走到第二步（请成员协助）的输入框。 */
function atAskCompose(): DemoGuideState {
  return run(started(), [...FIRST_STEP, { type: "next", prefill: ASK_SENTENCE }]);
}

/** 走到第二步的结果回到对话。 */
function atAskDone(): DemoGuideState {
  return run(atAskCompose(), [{ type: "composer-sent" }, { type: "assist-delivered" }, { type: "agent-settled" }]);
}

/** 走到第三步的项目设置。 */
function atSettings(): DemoGuideState {
  return run(atAskDone(), [{ type: "next" }]);
}

/** 走到第三步的授权弹窗。 */
function atHelpDialog(): DemoGuideState {
  return run(atSettings(), [{ type: "settings-opened" }, { type: "receiving-on" }, { type: "help-request-seen" }]);
}

describe("demo guide state machine", () => {
  it("starts on the join notice and opens the board tour once it is dismissed", () => {
    const state = joined();
    expect(state.status).toBe("active");
    expect(state.phase).toBe("joined");
    // 云端还没说演示开始时不会有这张提示窗：这里只认 `start`。
    expect(state.memberName).toBe("小饭团");
    const first = demoGuideReducer(state, { type: "joined-confirmed" });
    // 先看一圈看板，再动手：导览段的第一步是任务列表。
    expect(first.phase).toBe(DEMO_GUIDE_TOUR_PHASES[0]);
    // 提示窗本身不是一步：跳不了，也不会被当成第一步跳过。
    expect(demoGuideReducer(state, { type: "skip" })).toBe(state);
  });

  it("walks the board tour one step at a time and hands over to the hands-on experience", () => {
    // 导览五步：任务列表 → 协助 → 关联任务 → 关联会话 → 新建任务。
    // 「项目名与成员」那一步已删掉：它说的东西看板上本来就看得到。
    expect([...DEMO_GUIDE_TOUR_PHASES]).toEqual([
      "tour-board",
      "tour-tabs",
      "tour-associate",
      "tour-associate-pick",
      "tour-new-task"
    ]);
    let state = touring();
    expect(state.phase).toBe("tour-board");
    // 导览段没有进度、也不予跳过这一步。
    expect(demoGuideStepNumberOf(state.phase)).toBeNull();
    for (const [index, phase] of DEMO_GUIDE_TOUR_PHASES.entries()) {
      expect(state.phase).toBe(phase);
      expect(demoGuideTourIndex(phase)).toBe(index);
      expect(demoGuideStepNumberOf(phase)).toBeNull();
      if (index < DEMO_GUIDE_TOUR_PHASES.length - 1) {
        expect(demoGuideStartsExperience(phase)).toBe(false);
        // 「关联会话」要等扫描出结果：先替弹窗报个数，再点下一步。
        if (phase === "tour-associate-pick") {
          state = demoGuideReducer(state, { type: "scan-settled", count: 12 });
        }
        state = demoGuideReducer(state, { type: "next" });
      }
    }
    // 最后一步的主按钮是「开始协作」：点了才进体验的第一步。
    expect(demoGuideStartsExperience(state.phase)).toBe(true);
    expect(demoGuideNextTourPhase(state.phase)).toBe("task-row");
    const experience = demoGuideReducer(state, { type: "next" });
    expect(experience.phase).toBe("task-row");
    expect(demoGuideIsTourPhase(experience.phase)).toBe(false);
    expect(demoGuideStepNumberOf(experience.phase)).toBe(1);
    // 导览段不预填任何东西，也不写坏任何一项。
    expect(experience.prefill).toBeNull();
    expect(experience.done).toEqual({ task: false, ask: false, help: false });
    expect(experience.skipped).toEqual({ task: false, ask: false, help: false });
  });

  it("waits for the session scan before leaving the link-session step", () => {
    // 先走到「关联任务」那一站，再进「关联会话」：弹窗一出现就开始扫。
    const atPick = run(touring(), [{ type: "next" }, { type: "next" }, { type: "next" }]);
    expect(atPick.phase).toBe("tour-associate-pick");
    expect(atPick.scan).toEqual({ status: "scanning", count: 0 });
    // 扫描没结果：「下一步」不前进，人不会以为自己按了没反应。
    expect(demoGuideReducer(atPick, { type: "next" })).toBe(atPick);
    // 扫完了：给出计数，下一步才放行。
    const scanned = demoGuideReducer(atPick, { type: "scan-settled", count: 7 });
    expect(scanned.scan).toEqual({ status: "done", count: 7 });
    const after = demoGuideReducer(scanned, { type: "next" });
    expect(after.phase).toBe("tour-new-task");
  });

  it("moves past the link-session step when this computer has nothing to scan", () => {
    // 没授权读其他 Agent 的记录：这一步没有可展示的东西，直接接到下一站。
    const atPick = run(touring(), [{ type: "next" }, { type: "next" }, { type: "next" }]);
    const skipped = demoGuideReducer(atPick, { type: "scan-unavailable" });
    expect(skipped.phase).toBe("tour-new-task");
    expect(skipped.scan).toEqual({ status: "done", count: 0 });
    // 别的阶段发这两个事件不改变任何东西（同一个状态对象原样返回）。
    const board = touring();
    expect(demoGuideReducer(board, { type: "scan-settled", count: 3 })).toBe(board);
    const experience = started();
    expect(demoGuideReducer(experience, { type: "scan-unavailable" })).toBe(experience);
  });

  it("skips the whole walkthrough when the tour is skipped", () => {
    // 导览段没有「跳过这一步」：跳过引导就是整轮不看，小饭团随即离开。
    const skipped = demoGuideReducer(touring(), { type: "skip" });
    expect(skipped.status).toBe("ended");
    expect(skipped.endReason).toBe("skipped");
  });

  it("prefills the composer when continuing the member's task, then waits for the agent", () => {
    const state = run(started(), [
      { type: "task-opened" },
      { type: "task-continued", prefill: "接着小饭团的安排，写一段分享会的通知" }
    ]);
    expect(state.phase).toBe("compose");
    expect(state.prefill?.text).toBe("接着小饭团的安排，写一段分享会的通知");
    const sent = demoGuideReducer(state, { type: "composer-sent" });
    expect(sent.phase).toBe("reply-waiting");
    expect(demoGuideReducer(sent, { type: "agent-settled" }).phase).toBe("reply-done");
  });

  it("goes straight from the first step to asking a member for help", () => {
    const done = run(started(), FIRST_STEP);
    expect(done.phase).toBe("reply-done");
    expect(done.done.task).toBe(true);
    // 关联任务只是导览里的一句话：体验段没有这一步，直接去请成员协助，并把那句话填进输入框。
    const asking = demoGuideReducer(done, { type: "next", prefill: ASK_SENTENCE });
    expect(asking.phase).toBe("ask-compose");
    expect(asking.prefill?.text).toBe(ASK_SENTENCE);
  });

  it("only advances the asking step once the assist result is back and the agent settled again", () => {
    const waiting = demoGuideReducer(atAskCompose(), { type: "composer-sent" });
    expect(waiting.phase).toBe("ask-waiting");
    // Agent 先回的那一句不算：结果还没回来就不能给「下一步」。
    const settled = demoGuideReducer(waiting, { type: "agent-settled" });
    expect(settled.phase).toBe("ask-waiting");
    // 但它是「这一轮跑完了」的分界点：过了这里才允许判「没发出去」。
    expect(waiting.askTurnEnded).toBe(false);
    expect(settled.askTurnEnded).toBe(true);
    const delivered = demoGuideReducer(settled, { type: "assist-delivered" });
    expect(delivered.askDelivered).toBe(true);
    const done = demoGuideReducer(delivered, { type: "agent-settled" });
    expect(done.phase).toBe("ask-done");
    expect(done.done.ask).toBe(true);
    // 这一步完成就把那句话从状态里清掉：任务页之后再挂载也不会把它填回输入框。
    expect(done.prefill).toBeNull();
  });

  it("marks the round as ended only when the agent really finished it", () => {
    // 刚发出去：这一轮还没开始跑完，不能以此为由判失败。
    const waiting = demoGuideReducer(atAskCompose(), { type: "composer-sent" });
    expect(waiting.askTurnEnded).toBe(false);
    // 再发一次就重新算：上一轮的「已结束」不会带进新的一轮。
    const resent = demoGuideReducer({ ...atAskCompose(), askTurnEnded: true }, { type: "composer-sent" });
    expect(resent.askTurnEnded).toBe(false);
    // 这一轮跑完但结果还没回来：这时才置上。
    expect(demoGuideReducer(waiting, { type: "agent-settled" }).askTurnEnded).toBe(true);
  });

  it("only says the request was sent once the cloud has it", () => {
    const waiting = demoGuideReducer(atAskCompose(), { type: "composer-sent" });
    // 刚发出去：Agent 还在准备那次调用，请求还没建出来，这时不能说「已发出」。
    expect(waiting.askSeen).toBe(false);
    const seen = demoGuideReducer(waiting, { type: "assist-seen" });
    expect(seen.askSeen).toBe(true);
    // 再发一次重新算：上一轮遗留的「已发出」不会带进新的一轮。
    expect(demoGuideReducer({ ...atAskCompose(), askSeen: true }, { type: "composer-sent" }).askSeen).toBe(false);
  });

  it("drops the failure once the request turns up after all", () => {
    const failed = demoGuideReducer(
      demoGuideReducer(atAskCompose(), { type: "composer-sent" }),
      { type: "fail", reason: "协助请求没有发出去。" }
    );
    expect(failed.error).toBe("协助请求没有发出去。");
    // 请求后来才写进去：错误自己收起来，不需要人点「再试一次」。
    const seen = demoGuideReducer(failed, { type: "assist-seen" });
    expect(seen.error).toBeNull();
    expect(seen.phase).toBe("ask-waiting");
    // 没报过错时什么也不变：不白白换一个状态对象。
    expect(demoGuideReducer(seen, { type: "assist-seen" })).toBe(seen);
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
    expect(complete.done).toEqual({ task: true, ask: true, help: true });
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
    // 跳过第一步：直接去请成员协助，那句话跟着填上。
    const skippedTask = demoGuideReducer(started(), { type: "skip", prefill: ASK_SENTENCE });
    expect(skippedTask.phase).toBe("ask-compose");
    expect(skippedTask.skipped.task).toBe(true);
    expect(skippedTask.done.task).toBe(false);
    expect(skippedTask.prefill?.text).toBe(ASK_SENTENCE);

    // 跳过请成员协助：去项目设置，那句话一并收走。
    const settings = demoGuideReducer(skippedTask, { type: "skip" });
    expect(settings.phase).toBe("settings-open");
    expect(settings.skipped.ask).toBe(true);
    expect(settings.prefill).toBeNull();
  });

  it("ends without the completion dialog when every step was skipped", () => {
    const state = run(started(), [
      { type: "skip" },
      { type: "skip" },
      { type: "settings-opened" },
      { type: "skip" }
    ]);
    expect(state.status).toBe("ended");
    expect(state.endReason).toBe("skipped");
    expect(state.skipped).toEqual({ task: true, ask: true, help: true });
  });

  it("still offers the completion dialog when only the asking step was skipped", () => {
    const state = run(started(), [
      ...FIRST_STEP,
      { type: "next" },
      { type: "skip" },
      { type: "settings-opened" },
      { type: "receiving-on" },
      { type: "help-request-seen" },
      { type: "help-decided", allow: true },
      { type: "help-finished" },
      { type: "next" }
    ]);
    expect(state.status).toBe("complete");
    expect(state.done.ask).toBe(false);
    expect(state.skipped.ask).toBe(true);
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

  it("maps every phase to a step number and a heartbeat step the cloud accepts", () => {
    // 建项目之前的六屏、加入那一屏与看板导览都没有进度可讲：卡片上不出现「1 / 3」。
    for (const phase of DEMO_GUIDE_BEFORE_PROJECT_PHASES) expect(demoGuideStepNumberOf(phase)).toBeNull();
    expect(demoGuideStepNumberOf("joined")).toBeNull();
    for (const phase of DEMO_GUIDE_TOUR_PHASES) expect(demoGuideStepNumberOf(phase)).toBeNull();
    expect(demoGuideStepNumberOf("task-row")).toBe(1);
    expect(demoGuideStepNumberOf("reply-done")).toBe(1);
    expect(demoGuideStepNumberOf("ask-compose")).toBe(2);
    expect(demoGuideStepNumberOf("help-dialog")).toBe(3);
    // 云端只接受 1 / 2 / 3 / finish：三步与这三个值一一对应。
    expect(demoGuideHeartbeatStep("joined")).toBe("1");
    expect(demoGuideHeartbeatStep("tour-board")).toBe("1");
    expect(demoGuideHeartbeatStep("reader")).toBe("1");
    expect(demoGuideHeartbeatStep("ask-done")).toBe("2");
    expect(demoGuideHeartbeatStep("settings-open")).toBe("3");
    expect(demoGuideHeartbeatStep("help-running")).toBe("3");
    expect(demoGuideHeartbeatStep("complete")).toBe("finish");
  });

  it("starts on the intro screen with nothing to skip", () => {
    const before = demoGuideReducer(raw(), { type: "start-before-project" });
    expect(before.status).toBe("active");
    expect(before.phase).toBe("intro");
    // 还没有云端项目：心跳与结束演示都无处可发。
    expect(before.projectId).toBeNull();
    expect(before.memberUserId).toBeNull();
    // 这一步跳不了：不建项目就没有后面的演示；取消这一步不是「退出」，直接回到空闲。
    expect(demoGuideReducer(before, { type: "skip" }).phase).toBe("intro");
    expect(demoGuideReducer(before, { type: "end", reason: "exited" }).status).toBe("ended");
  });

  it("walks the six screens of the create dialog in order", () => {
    // 出场 → 名称 → 文件夹 → 协作 → 加入项目 → 创建项目；顺序不可调。
    expect([...DEMO_GUIDE_BEFORE_PROJECT_PHASES]).toEqual([
      "intro",
      "name",
      "folder",
      "collab",
      "join-entry",
      "create-project"
    ]);
    let state = demoGuideReducer(raw(), { type: "start-before-project" });
    for (const [index, phase] of DEMO_GUIDE_BEFORE_PROJECT_PHASES.entries()) {
      expect(state.status).toBe("active");
      expect(state.phase).toBe(phase);
      expect(demoGuideIsBeforeProjectPhase(phase)).toBe(true);
      // 这一段没有进度、没有心跳项目、也不预填任何东西。
      expect(demoGuideStepNumberOf(phase)).toBeNull();
      expect(demoGuideHeartbeatStep(phase)).toBe("1");
      expect(state.projectId).toBeNull();
      expect(state.prefill).toBeNull();
      // 这六屏都没有「跳过这一步」：跳过无效。
      expect(demoGuideReducer(state, { type: "skip" })).toBe(state);
      const next = demoGuideNextBeforeProjectPhase(phase);
      if (index < DEMO_GUIDE_BEFORE_PROJECT_PHASES.length - 1) {
        expect(next).toBe(DEMO_GUIDE_BEFORE_PROJECT_PHASES[index + 1]);
        state = demoGuideReducer(state, { type: "next" });
      } else {
        expect(next).toBeNull();
      }
    }
    // 最后一屏靠人点真实的「创建项目」：收到「下一步」保持不动。
    expect(demoGuideReducer(state, { type: "next" })).toBe(state);
  });

  it("only skips the join entry when that screen is current", () => {
    const before = demoGuideReducer(raw(), { type: "start-before-project" });
    expect(demoGuideReducer(before, { type: "skip-join-entry" })).toBe(before);
    // 一路走到「加入项目」那一屏：这时候跳过它才有效。
    const joinEntry = run(before, [
      { type: "next" },
      { type: "next" },
      { type: "next" },
      { type: "next" }
    ]);
    expect(joinEntry.phase).toBe("join-entry");
    expect(demoGuideReducer(joinEntry, { type: "skip-join-entry" }).phase).toBe("create-project");
    // 已经到「创建项目」之后就不再理会这个事件。
    const submit = demoGuideReducer(joinEntry, { type: "skip-join-entry" });
    expect(demoGuideReducer(submit, { type: "skip-join-entry" })).toBe(submit);
  });

  it("drops the before-project screens as soon as the cloud starts the demo", () => {
    // 建项目之前这六屏都算是「还在弹窗上」：取消弹窗能把任意一屏收起来。
    let state = demoGuideReducer(raw(), { type: "start-before-project" });
    for (let index = 0; index < DEMO_GUIDE_BEFORE_PROJECT_PHASES.length - 1; index += 1) {
      expect(demoGuideIsBeforeProjectPhase(state.phase)).toBe(true);
      state = demoGuideReducer(state, { type: "next" });
    }
    expect(state.phase).toBe("create-project");
    expect(demoGuideIsBeforeProjectPhase(state.phase)).toBe(true);
    // 云端建好项目后直接进「加入」那一屏，不再回弹窗。
    expect(demoGuideReducer(state, { type: "start", input: START }).phase).toBe("joined");
  });

  it("shows the join notice right after the project is created, before the first step", () => {
    const before = demoGuideReducer(raw(), { type: "start-before-project" });
    const started = demoGuideReducer(before, { type: "start", input: START });
    expect(started.phase).toBe("joined");
    expect(started.projectId).toBe("cloud-1");
    expect(started.memberName).toBe("小饭团");
    // 演示成员第一次出场用的还是同一个昵称：点完提示窗进看板导览。
    expect(demoGuideReducer(started, { type: "joined-confirmed" }).phase).toBe("tour-board");
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
    // 做完第一步才换下一句：请成员协助时那句是新的一句。
    const asked = demoGuideReducer({ ...first, phase: "reply-done" }, { type: "next", prefill: "第二句" });
    expect(asked.prefill).toMatchObject({ text: "第二句", nonce: 2 });
  });
});
