/**
 * 小饭团演示的状态机：看板导览的推进、体验段那一步的进入与推进条件、跳过、退出、出错与重试，
 * 以及心跳上报的步骤。
 *
 * 这些规则都不依赖界面，所以按 reducer 直接断言；界面只负责发事件与画卡片。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_GUIDE_BEFORE_PROJECT_PHASES,
  DEMO_GUIDE_TOUR_PHASES,
  clearDemoGuideDone,
  demoGuideAcceptsFailure,
  demoGuideHeartbeatStep,
  demoGuideIsBeforeProjectPhase,
  demoGuideIsTourPhase,
  demoGuideNextBeforeProjectPhase,
  demoGuideNextTourPhase,
  demoGuideReducer,
  demoGuideStartsExperience,
  demoGuideStepNumberOf,
  demoGuideTourIndex,
  dismissDemoGuideBeforeProject,
  dispatchDemoGuide,
  endDemoGuide,
  getDemoGuideState,
  markDemoGuideDone,
  readDemoGuideDone,
  resetDemoGuideStore,
  setDemoGuideStorageForTest,
  startDemoGuideBeforeProject,
  type DemoGuideEvent,
  type DemoGuideState
} from "../collab-demo-guide-store.js";

const START = {
  projectId: "cloud-1",
  localProjectId: "local-1",
  memberUserId: "9001",
  memberName: "小饭团"
};

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

/** 导览走完、点了〔开始协作〕：体验那一步的蒙版。 */
function started(): DemoGuideState {
  // 导览四步一路点「下一步」：最后一步的按钮是「开始协作」，点完就是体验那一步。
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
    // 导览四步：任务列表 → 关联任务 → 关联会话 → 新建任务。
    // 「项目名与成员」那一站已删掉：看板上本来就看得到。
    expect([...DEMO_GUIDE_TOUR_PHASES]).toEqual([
      "tour-board",
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
    expect(experience.done).toEqual({ task: false });
    expect(experience.skipped).toEqual({ task: false });
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

  it("asks for the authorization in this very step, then scans, then lets the person move on", () => {
    // 没授权：弹窗退回授权说明，「下一步」换成「授权并查看」。
    const atPick = run(touring(), [{ type: "next" }, { type: "next" }, { type: "next" }]);
    const locked = demoGuideReducer(atPick, { type: "scan-locked" });
    expect(locked.scan).toEqual({ status: "locked", count: 0 });
    // 没授权时「下一步」也过不去：这一站要真的把会话摆出来才能往下走。
    expect(demoGuideReducer(locked, { type: "next" })).toBe(locked);

    // 点了「授权并查看」：进安装态，重复点不再发第二次。
    const granting = demoGuideReducer(locked, { type: "grant-access" });
    expect(granting.scan).toEqual({ status: "granting", count: 0 });
    expect(demoGuideReducer(granting, { type: "grant-access" })).toBe(granting);

    // 装完：真的开始扫，扫完才放行。
    const scanning = demoGuideReducer(granting, { type: "grant-settled" });
    expect(scanning.scan).toEqual({ status: "scanning", count: 0 });
    expect(demoGuideReducer(scanning, { type: "next" })).toBe(scanning);
    const done = demoGuideReducer(scanning, { type: "scan-settled", count: 0 });
    expect(done.scan).toEqual({ status: "done", count: 0 });
    expect(demoGuideReducer(done, { type: "next" }).phase).toBe("tour-new-task");
  });

  it("goes back to the authorization note when it did not finish, and lets the person skip the stop", () => {
    const granting = run(touring(), [
      { type: "next" },
      { type: "next" },
      { type: "next" },
      { type: "scan-locked" },
      { type: "grant-access" }
    ]);
    const failed = demoGuideReducer(granting, { type: "grant-failed", reason: "没有完成授权" });
    expect(failed.scan).toEqual({ status: "locked", count: 0 });
    expect(failed.error).toBe("没有完成授权");
    // 再试一次就是清掉原因，卡片回到「授权并查看」。
    expect(demoGuideReducer(failed, { type: "retry" }).error).toBeNull();

    // 只放过这一站：往下一站走，不结束整轮。
    const passed = demoGuideReducer(failed, { type: "pass" });
    expect(passed.phase).toBe("tour-new-task");
    expect(passed.status).toBe("active");
    expect(passed.scan).toEqual({ status: "idle", count: 0 });

    // 正在装、或已经扫完：迟到的「没授权」不能把它顶回去（看板读到的授权状态比这里晚一步）。
    const retried = demoGuideReducer(failed, { type: "retry" });
    const grantingAgain = demoGuideReducer(retried, { type: "grant-access" });
    expect(grantingAgain.scan).toEqual({ status: "granting", count: 0 });
    expect(demoGuideReducer(grantingAgain, { type: "scan-locked" })).toBe(grantingAgain);
    const finished = demoGuideReducer(demoGuideReducer(grantingAgain, { type: "grant-settled" }), { type: "scan-settled", count: 4 });
    expect(finished.scan).toEqual({ status: "done", count: 4 });
    expect(demoGuideReducer(finished, { type: "scan-locked" })).toBe(finished);

    // 别的阶段发这几条都不改变任何东西（同一个状态对象原样返回）。
    const board = touring();
    expect(demoGuideReducer(board, { type: "scan-settled", count: 3 })).toBe(board);
    expect(demoGuideReducer(board, { type: "scan-locked" })).toBe(board);
    expect(demoGuideReducer(board, { type: "pass" })).toBe(board);
    expect(demoGuideReducer(board, { type: "grant-access" })).toBe(board);
    const experience = started();
    expect(demoGuideReducer(experience, { type: "scan-locked" })).toBe(experience);
    expect(demoGuideReducer(experience, { type: "pass" })).toBe(experience);
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

  it("ends the walkthrough once the member's task is continued", () => {
    const done = run(started(), FIRST_STEP);
    expect(done.phase).toBe("reply-done");
    expect(done.done.task).toBe(true);
    // 接续成员的任务就是引导的最后一屏：点「完成」就收场，不再有第二段体验。
    const complete = demoGuideReducer(done, { type: "next" });
    expect(complete.status).toBe("complete");
    expect(complete.phase).toBe("complete");
    expect(complete.endReason).toBe("finished");
    expect(complete.done).toEqual({ task: true });
  });

  it("offers no way back once the reply is in", () => {
    const replied = run(started(), FIRST_STEP);
    // 事情已经办成：卡片上不给上一步，reducer 也不动。
    expect(replied.phase).toBe("reply-done");
    expect(demoGuideReducer(replied, { type: "back" })).toBe(replied);
  });

  it("ends without the completion dialog when the only step is skipped", () => {
    // 体验段只有一步：跳过它就是整轮没做，直接收场，不摆完成弹窗。
    const ended = demoGuideReducer(started(), { type: "skip" });
    expect(ended.status).toBe("ended");
    expect(ended.endReason).toBe("skipped");
    expect(ended.skipped).toEqual({ task: true });
  });

  it("gives the step that can fail a way out", () => {
    // 只剩一步：失败也只可能在「等小饭团回复」那一屏上成立，这里就停在那一屏。
    const waiting = run(started(), [
      { type: "task-opened" },
      { type: "task-continued", prefill: "接着写" },
      { type: "composer-sent" }
    ]);
    expect(waiting.phase).toBe("reply-waiting");
    expect(demoGuideAcceptsFailure(waiting.phase)).toBe(true);
    const failed = demoGuideReducer(waiting, { type: "fail", reason: "Agent 没有给出回复。" });
    expect(failed.error).toBe("Agent 没有给出回复。");
    // 再试一次：清掉原因，人还停在原处等。
    const retried = demoGuideReducer(failed, { type: "retry" });
    expect(retried.error).toBeNull();
    expect(retried.phase).toBe("reply-waiting");
    // 不想等就跳过：整轮收场，项目与成员都保留。
    const skipped = demoGuideReducer(failed, { type: "skip" });
    expect(skipped.status).toBe("ended");
    expect(skipped.endReason).toBe("skipped");
    // 其余屏都不接失败：没在等结果的地方报错就是误报。
    expect(demoGuideAcceptsFailure("compose")).toBe(false);
    expect(demoGuideAcceptsFailure("reply-done")).toBe(false);
    expect(demoGuideAcceptsFailure("complete")).toBe(false);
  });

  it("ignores a failure that arrives after the person went back", () => {
    // 人从「等回复」退回输入框，被叫停的那一轮随后报错：这一句不该落在新的一屏上。
    const waiting = run(started(), [
      { type: "task-opened" },
      { type: "task-continued", prefill: "接着写" },
      { type: "composer-sent" }
    ]);
    expect(waiting.phase).toBe("reply-waiting");
    const back = demoGuideReducer(waiting, { type: "back" });
    expect(back.phase).toBe("compose");
    expect(demoGuideReducer(back, { type: "fail", reason: "Agent 这一轮没有给出结果。" })).toBe(back);
    expect(demoGuideReducer(back, { type: "fail", reason: "Agent 这一轮没有给出结果。" }).error).toBeNull();
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
    // 建项目之前的六屏、加入那一屏与看板导览都没有进度可讲：卡片上不出现「1 / 1」。
    for (const phase of DEMO_GUIDE_BEFORE_PROJECT_PHASES) expect(demoGuideStepNumberOf(phase)).toBeNull();
    expect(demoGuideStepNumberOf("joined")).toBeNull();
    for (const phase of DEMO_GUIDE_TOUR_PHASES) expect(demoGuideStepNumberOf(phase)).toBeNull();
    expect(demoGuideStepNumberOf("task-row")).toBe(1);
    expect(demoGuideStepNumberOf("reply-done")).toBe(1);
    // 收尾那两屏也不是一步。
    expect(demoGuideStepNumberOf("complete")).toBeNull();
    // 云端只接受 1 / 2 / 3 / finish：只剩一步，其余阶段都报 1，收场报 finish。
    expect(demoGuideHeartbeatStep("joined")).toBe("1");
    expect(demoGuideHeartbeatStep("tour-board")).toBe("1");
    expect(demoGuideHeartbeatStep("reader")).toBe("1");
    expect(demoGuideHeartbeatStep("reply-done")).toBe("1");
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
    const failed = demoGuideReducer(
      run(started(), [{ type: "task-opened" }, { type: "task-continued", prefill: "接着写" }, { type: "composer-sent" }]),
      { type: "fail", reason: "Agent 这一轮没有给出结果。" }
    );
    // 轮询每拍都会读到同一个失败结果：同一个原因不换新对象，界面不会跟着重画。
    expect(demoGuideReducer(failed, { type: "fail", reason: "Agent 这一轮没有给出结果。" })).toBe(failed);
    expect(demoGuideReducer(failed, { type: "fail", reason: "另一个原因" }).error).toBe("另一个原因");
  });

  it("prefills the composer once and refills it when the person goes back", () => {
    // 引导里只剩这一处预填：接着成员的任务写那句话。
    const first = run(started(), [{ type: "task-opened" }, { type: "task-continued", prefill: "第一句" }]);
    expect(first.phase).toBe("compose");
    expect(first.prefill).toMatchObject({ text: "第一句", nonce: 1 });
    // 退回只读面板这种不写句子的屏：预填清掉，不把旧句子留在状态里。
    const back = demoGuideReducer(first, { type: "back" });
    expect(back.phase).toBe("reader");
    expect(back.prefill).toBeNull();
    // 再进输入框：句子重新填一次（换一个 prefill 对象，输入框据此再填一遍）。
    const again = demoGuideReducer(back, { type: "task-continued", prefill: "第一句" });
    expect(again.phase).toBe("compose");
    expect(again.prefill?.text).toBe("第一句");
    expect(again.prefill?.nonce).toBeGreaterThan(0);
    // 从「等回复」退回输入框：句子同样重新填上，且 nonce 比上一次大。
    const waiting = demoGuideReducer(again, { type: "composer-sent" });
    expect(waiting.phase).toBe("reply-waiting");
    const fromWaiting = demoGuideReducer(waiting, { type: "back", prefill: "第一句" });
    expect(fromWaiting.phase).toBe("compose");
    expect(fromWaiting.prefill?.text).toBe("第一句");
    expect(fromWaiting.prefill!.nonce).toBeGreaterThan(again.prefill!.nonce);
  });

  it("goes back one screen at a time, not one step at a time", () => {
    // 建项目之前：六屏一屏一屏退回去，最后退到出场那一屏就不再退。
    let before = demoGuideReducer(raw(), { type: "start-before-project" });
    before = run(before, [{ type: "next" }, { type: "next" }, { type: "next" }]);
    expect(before.phase).toBe("collab");
    expect(demoGuideReducer(before, { type: "back" }).phase).toBe("folder");
    const intro = run(before, [{ type: "back" }, { type: "back" }, { type: "back" }]);
    expect(intro.phase).toBe("intro");
    // 已经是第一屏：再点也不动。
    expect(demoGuideReducer(intro, { type: "back" })).toBe(intro);
  });

  it("scans again when the person goes back to the link-session step", () => {
    // 「关联会话」扫完、已经去了下一站，人点了「上一步」：弹窗会重新打开、重新扫一遍，
    // 所以扫描进度要回到「正在扫」，不能留着上一次的计数让按钮一进去就可点。
    const scanned = run(touring(), [
      { type: "next" },
      { type: "next" },
      { type: "next" },
      { type: "scan-settled", count: 7 },
      { type: "next" }
    ]);
    expect(scanned.phase).toBe("tour-new-task");
    const back = demoGuideReducer(scanned, { type: "back" });
    expect(back.phase).toBe("tour-associate-pick");
    expect(back.scan).toEqual({ status: "scanning", count: 0 });
    expect(demoGuideReducer(back, { type: "next" })).toBe(back);
    // 退回来重新扫时看板会按当时的授权状态再判一次：已授权就直接扫，没授权就退回门帘。
    const relocked = demoGuideReducer(back, { type: "scan-locked" });
    expect(relocked.scan).toEqual({ status: "locked", count: 0 });
  });

});

/** 一个最小的内存存储：退出标记跨重启保留这件事只跟存储有关，不必真用 localStorage。 */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    key: (index: number) => Array.from(items.keys())[index] ?? null,
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: (key: string, value: string) => {
      items.set(key, String(value));
    }
  } as Storage;
}

describe("leaving the walkthrough once is enough", () => {
  it("records the exit on this machine and never clears it by itself", () => {
    const storage = memoryStorage();
    expect(readDemoGuideDone(storage)).toBe(false);
    markDemoGuideDone(storage);
    // 换一个「进程」读同一份存储：退出过后就不再引导，重启不算重新开始。
    expect(readDemoGuideDone(storage)).toBe(true);
    markDemoGuideDone(storage);
    expect(readDemoGuideDone(storage)).toBe(true);
    // 只有测试与自助重置会把它清掉。
    clearDemoGuideDone(storage);
    expect(readDemoGuideDone(storage)).toBe(false);
  });

  it("treats an unreadable storage as not yet exited instead of blocking new projects", () => {
    const broken = {
      getItem: () => {
        throw new Error("quota");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("quota");
      }
    } as unknown as Storage;
    expect(readDemoGuideDone(broken)).toBe(false);
    // 写不进去也不抛错：这一次照常走完，下次最多再引导一次。
    expect(() => markDemoGuideDone(broken)).not.toThrow();
    expect(() => clearDemoGuideDone(broken)).not.toThrow();
  });
});

describe("a walkthrough that ended stays ended on this machine", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
    resetDemoGuideStore();
    setDemoGuideStorageForTest(storage);
  });

  afterEach(() => {
    resetDemoGuideStore();
  });

  it("records the exit at any moment, even before the project exists", async () => {
    dispatchDemoGuide({ type: "start-before-project" });
    expect(getDemoGuideState().status).toBe("active");
    // 建项目之前退出：云端还没有项目可记，标记只能由本机写。
    expect(readDemoGuideDone(storage)).toBe(false);
    await endDemoGuide("exited");
    expect(getDemoGuideState().status).toBe("ended");
    expect(readDemoGuideDone(storage)).toBe(true);
  });

  it("records skipping and finishing the same way as exiting", async () => {
    dispatchDemoGuide({ type: "start-before-project" });
    dispatchDemoGuide({ type: "next" });
    await endDemoGuide("skipped");
    expect(readDemoGuideDone(storage)).toBe(true);
  });

  it("treats closing the new-project dialog as nothing to remember", () => {
    dispatchDemoGuide({ type: "start-before-project" });
    // 关掉弹窗只是收起蒙版：没建项目，也没说不想看，以后还能引导。
    dismissDemoGuideBeforeProject();
    expect(getDemoGuideState().status).toBe("ended");
    expect(readDemoGuideDone(storage)).toBe(false);
  });

  it("refuses to start another walkthrough once this machine left one", () => {
    markDemoGuideDone(storage);
    startDemoGuideBeforeProject();
    expect(getDemoGuideState().status).toBe("ended");
  });
});
