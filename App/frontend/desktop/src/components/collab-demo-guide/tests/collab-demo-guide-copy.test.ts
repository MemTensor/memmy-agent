/**
 * 说明卡上的字：一句都不能漏掉占位符。
 *
 * `formatMessage` 只替换传进来的那几项，没传的 `{name}` 会原样留在句子里——之前 `settings-open`
 * 就是这么把「{name}的问题」印到卡片上的。这里把每个子状态、两种语言的卡片都生成一遍，
 * 断言正文里不出现字面的 `{`；顺带把导览四步与那句无名字的文案钉住。
 */
import { describe, expect, it } from "vitest";
import { formatMessage, messageCatalogs, type MessageKey } from "../../../i18n/messages.js";
import type { DemoGuidePhase, DemoGuideState } from "../../../app/collab-demo-guide-store.js";
import { demoGuideCard, demoGuideTourCard } from "../collab-demo-guide-overlay.js";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/** 真实目录里的那句话：与界面上的 t() 同一个函数，缺键时直接报错而不是悄悄返回空串。 */
function translate(language: "zh-CN" | "en-US"): Translate {
  return (key, values) => {
    const template = messageCatalogs[language][key];
    if (typeof template !== "string" || template.length === 0) {
      throw new Error(`missing message: ${language} ${String(key)}`);
    }
    return formatMessage(template, values);
  };
}

/** 引导的每一个子状态：删掉一步之后仍要逐个看一遍。 */
const PHASES: DemoGuidePhase[] = [
  "create-project",
  "joined",
  "tour-board",
  "tour-tabs",
  "tour-associate",
  "tour-new-task",
  "task-row",
  "reader",
  "compose",
  "reply-waiting",
  "reply-done",
  "ask-compose",
  "ask-waiting",
  "ask-done",
  "settings-open",
  "settings-assist",
  "help-waiting",
  "help-dialog",
  "help-running",
  "help-done",
  "help-rejected",
  "complete"
];

function stateFor(phase: DemoGuidePhase): DemoGuideState {
  return {
    status: "active",
    phase,
    projectId: "cloud-1",
    localProjectId: "local-1",
    memberUserId: "9001",
    memberName: "小饭团",
    error: null,
    done: { task: false, ask: false, help: false },
    skipped: { task: false, ask: false, help: false },
    askDelivered: false,
    askTurnEnded: false,
    prefill: null,
    endReason: null,
    cloudEnded: false
  };
}

describe("the demo guide copy", () => {
  it("never prints a raw placeholder on the card", () => {
    for (const language of ["zh-CN", "en-US"] as const) {
      const t = translate(language);
      const cards = [
        ...PHASES.map((phase) => demoGuideCard(stateFor(phase), t)),
        // 导览段按序号取文案：四步都要有，不能落回空串。
        ...[0, 1, 2, 3].map((index) => demoGuideTourCard(index, t))
      ];
      for (const card of cards) {
        for (const text of [card.title, card.body, card.status, card.badge, card.stepName]) {
          if (text === null) continue;
          expect(text, `${language} ${card.stepName ?? ""}`).not.toContain("{");
        }
      }
    }
  });

  it("keeps the approved wording for the step whose name is written out", () => {
    const t = translate("zh-CN");
    // 第三步的这句话按定稿写死了演示成员的名字，卡片上不出现字面的 {name}。
    expect(demoGuideCard(stateFor("settings-open"), t).body)
      .toBe("小饭团那边也需要你帮个忙，先去项目设置里打开接收请求。");
    expect(demoGuideCard(stateFor("settings-open"), translate("en-US")).body)
      .toBe("Xiaofantuan needs a hand from you too; turn on accepting requests in project settings first.");
    // 不带人名的句子照旧不写死叫法：执行中的状态只说结果回传给对方。
    expect(demoGuideCard(stateFor("help-running"), t).status).toBe("正在执行，完成后结果将回传给对方。");
  });

  it("keeps the four tour steps in the approved words", () => {
    const zh = [0, 1, 2, 3].map((index) => demoGuideTourCard(index, translate("zh-CN")));
    expect(zh.map((card) => card.stepName)).toEqual(["任务列表", "协助", "关联任务", "新建任务"]);
    expect(zh.map((card) => card.body)).toEqual([
      "你和成员的任务都在这里，谁做到哪一步都看得到。",
      "协助指把任务交给成员电脑上的 Agent 执行，结果回写到发起它的任务中。",
      "在其他本地 Agent 中执行的任务，也可以关联到这里。",
      "点击这里，可以新建一条与成员共享的任务。"
    ]);
    const en = [0, 1, 2, 3].map((index) => demoGuideTourCard(index, translate("en-US")));
    expect(en.map((card) => card.stepName)).toEqual(["Task list", "Assistance", "Linked tasks", "New task"]);
    expect(en.map((card) => card.body)).toEqual([
      "Your tasks and your members' tasks all live here, so you can see how far each has got.",
      "Assistance hands a task to the Agent on a member's computer; the result is written back to the task that asked for it.",
      "Tasks that ran in your other local Agents can be linked here too.",
      "Click here to create a task shared with your members."
    ]);
  });

  it("names the three experience steps the way the prototype does", () => {
    const names = (language: "zh-CN" | "en-US") => [1, 2, 3]
      .map((step) => translate(language)(("collab.demo.stepName." + String(step)) as MessageKey));
    expect(names("zh-CN")).toEqual(["接续成员的任务", "请成员协助", "为成员执行任务"]);
    expect(names("en-US")).toEqual(["Continue a member's task", "Ask a member to assist", "Run a task for a member"]);
  });

  it("reads the authorization step with a title and the notice that follows", () => {
    // 授权弹窗那一步：标题写谁发来的请求，正文说他为什么需要这台电脑，并顺带说明执行方可以换。
    expect(demoGuideCard(stateFor("help-dialog"), translate("zh-CN"))).toMatchObject({
      title: "小饭团发来了一条协助请求",
      body: "分享会要现场演示，他想先确认这台电脑的系统版本。可以选择其他本地 Agent 执行，不过这次就先交给 Memmy 吧。"
    });
    // 拒绝之后只有一句「你拒绝了这次请求。」，没有额外的标题。
    expect(demoGuideCard(stateFor("help-rejected"), translate("zh-CN"))).toMatchObject({
      title: null,
      body: "你拒绝了这次请求。"
    });
  });
});
