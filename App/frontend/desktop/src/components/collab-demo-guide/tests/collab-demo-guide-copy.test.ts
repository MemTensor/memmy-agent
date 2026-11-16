/**
 * 说明卡上的字：一句都不能漏掉占位符。
 *
 * `formatMessage` 只替换传进来的那几项，没传的 `{name}` 会原样留在句子里——之前 `settings-open`
 * 就是这么把「{name}的问题」印到卡片上的。这里把每个子状态、两种语言的卡片都生成一遍，
 * 断言正文里不出现字面的 `{`；顺带把导览四步与那句无名字的文案钉住。
 */
import { describe, expect, it } from "vitest";
import { formatMessage, messageCatalogs, type MessageKey } from "../../../i18n/messages.js";
import { DEMO_GUIDE_COPY_FALLBACK, type DemoGuidePhase, type DemoGuideState } from "../../../app/collab-demo-guide-store.js";
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
    copy: DEMO_GUIDE_COPY_FALLBACK,
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
      .toBe("现在小饭团也需要你电脑上的信息。先去项目设置，打开「接收协助请求」。");
    expect(demoGuideCard(stateFor("settings-open"), translate("en-US")).body)
      .toBe("Now Xiaofantuan needs something from your computer. Open project settings and turn on Accept assistance requests.");
    // 不带人名的句子照旧不写死叫法：执行中的状态只说结果回传给发起的人。
    expect(demoGuideCard(stateFor("help-running"), t).status)
      .toBe("正在本机执行，完成后结果会回传给小饭团。");
  });

  it("keeps the four tour steps in the approved words", () => {
    const zh = [0, 1, 2, 3].map((index) => demoGuideTourCard(index, translate("zh-CN")));
    expect(zh.map((card) => card.stepName)).toEqual(["任务列表", "协助", "关联任务", "新建任务"]);
    expect(zh.map((card) => card.body)).toEqual([
      "成员共享的任务都在这里。每项任务的完整对话与进展都能读到，也可以接着往下推进，不用反复同步背景。",
      "有些信息和操作只在成员自己的电脑上，比如他的本地文件、本机环境。任务里需要这些时，向成员发起协助请求，他确认后由他电脑上的 Agent 执行，结果回写到你的任务中。双方的协助记录都在这里。",
      "你在 Claude Code、Cursor 等外部工具里做的工作，成员默认看不到。把那段会话关联进项目，成员就能读到完整上下文并接着处理，不用再讲一遍；关联整个分组后，该分组新增的会话也会自动进入项目。",
      "需要开展新工作时，从这里新建任务。项目内新建的任务默认对成员可见，方便他们查看进展、接着推进或发起协助。"
    ]);
    const en = [0, 1, 2, 3].map((index) => demoGuideTourCard(index, translate("en-US")));
    expect(en.map((card) => card.stepName)).toEqual(["Task list", "Assistance", "Linked tasks", "New task"]);
    expect(en.map((card) => card.body)).toEqual([
      "Tasks shared by members live here. You can read each task's full conversation and progress, and carry on from where it stopped without briefing each other again.",
      "Some information and actions only exist on a member's own computer, such as their local files or their machine's environment. When a task needs them, send the member an assistance request; once they confirm, the Agent on their computer runs it and the result is written back to your task. Requests from both sides are listed here.",
      "Work you did in Claude Code, Cursor and other external tools is invisible to members by default. Link that session to the project and members can read the full context and carry on, without you retelling it. Link a whole group and its new sessions come in automatically.",
      "Start new work here. New tasks in this project are visible to members by default, so they can follow progress, carry on, or ask for assistance."
    ]);
  });

  it("names the three experience steps the way the prototype does", () => {
    const names = (language: "zh-CN" | "en-US") => [1, 2, 3]
      .map((step) => translate(language)(("collab.demo.stepName." + String(step)) as MessageKey));
    expect(names("zh-CN")).toEqual(["接续成员的任务", "请求成员协助", "处理成员的协助请求"]);
    expect(names("en-US")).toEqual(["Continue a member's task", "Request a member's assistance", "Handle a member's assistance request"]);
  });

  it("reads the authorization step with a title and the notice that follows", () => {
    // 授权弹窗那一步：标题写谁发来的请求，正文说他为什么需要这台电脑，并顺带说明执行方可以换。
    expect(demoGuideCard(stateFor("help-dialog"), translate("zh-CN"))).toMatchObject({
      title: "小饭团发来了一条协助请求",
      body: "他请你电脑上的 Agent 确认这台电脑的系统版本。可以选择其他本地 Agent 执行，不过这次就先交给 Memmy 吧。"
    });
    // 拒绝之后只有一句「已拒绝本次协助请求，这台电脑未执行任何操作。」，没有额外的标题。
    expect(demoGuideCard(stateFor("help-rejected"), translate("zh-CN"))).toMatchObject({
      title: null,
      body: "已拒绝本次协助请求，这台电脑未执行任何操作。"
    });
  });

  it("reads the scenario content from the cloud instead of writing its own", () => {
    // 剧本一句都不该在客户端写死：云端换了任务名与要接着做的事，卡片上的字跟着换。
    // 从前两边各写一份，云端改剧本后同一屏里会同时出现「项目协作上手清单」和「分享会通知」。
    const custom = {
      taskTitle: "下周五的团队分享会",
      taskNext: "写一段分享会的通知",
      askSentence: "查一下上次分享会一共来了多少人",
      helpSentence: "确认这台电脑的系统版本"
    };
    const t = translate("zh-CN");
    const state = (phase: DemoGuidePhase): DemoGuideState => ({ ...stateFor(phase), copy: custom });

    expect(demoGuideCard(state("task-row"), t).body).toContain("下周五的团队分享会");
    expect(demoGuideCard(state("reader"), t).body).toContain("写一段分享会的通知");
    // 授权弹窗这一屏必须说清对方要这台电脑做什么，内容同样来自云端。
    expect(demoGuideCard(state("help-dialog"), t).body).toContain("确认这台电脑的系统版本");
    expect(demoGuideCard(state("help-done"), t).body).toContain("确认这台电脑的系统版本");
    // 换了剧本，客户端原来那套内容不得再出现。
    const bodies = PHASES
      .map((phase) => demoGuideCard(state(phase), t))
      .flatMap((card) => [card.title, card.body, card.status])
      .filter((text): text is string => Boolean(text))
      .join(" ");
    // 自指的旧剧本（清单 / FAQ / 介绍产品）不得再出现在任何一屏上。
    for (const stale of ["上手清单", "项目协作常见问题", "介绍一下 Memmy"]) {
      expect(bodies, stale).not.toContain(stale);
    }
  });

  it("keeps the six screens before the project exists and the joining screen", () => {
    // 建项目之前的六屏与加入项目这一屏：这两段的挂载由结构那边决定，这里先把字钉住，
    // 改一个字、少一个键都会失败（`translate` 缺键时直接报错）。
    const expected: Array<[MessageKey, string, string]> = [
      ["collab.demo.intro.badge", "官方", "Official"],
      ["collab.demo.intro.name", "小饭团", "Xiaofantuan"],
      ["collab.demo.intro.body", "你好，我是小饭团，接下来由我带你体验项目协作。开始前，先看创建项目时的几项设置。", "Hi, I am Xiaofantuan. I will take you through project collaboration. Before we start, a look at the settings when creating a project."],
      ["collab.demo.name.body", "项目建好后会按这个名字显示在左侧栏，成员看到的名称和你一致。本次已预填，可以直接使用。", "The project appears under this name in the sidebar, and members see the same name. It is already filled in for this walkthrough."],
      ["collab.demo.folder.body", "在这里指定 Agent 工作的本地文件夹。读写都在你的电脑上完成，文件夹内容不会上传。", "This is the local folder the Agent works in. Reading and writing happen on your computer, and the folder is not uploaded."],
      ["collab.demo.collab.body", "开启后成员可以加入这个项目、共享任务并互相请求协助；关闭后只作为你个人的本地项目。", "While it is on, members can join the project, share tasks and ask each other for assistance; turned off, it is only your own local project."],
      ["collab.demo.joinEntry.body", "如果其他成员已经建好项目并邀请了你，可以从这里直接加入。", "If a member has already created a project and invited you, you can join it right here."],
      ["collab.demo.submit.body", "各项已就绪，点击「创建项目」，接下来进入项目看板。", "Everything is ready. Choose Create and we move on to the project board."],
      ["collab.demo.joined.body", "项目里还没有其他成员。这次先由我加入项目，带你完成一次协作。", "There are no other members in this project yet. Let me join for this walkthrough and run one collaboration with you."],
      ["collab.demo.joined.continue", "继续", "Continue"]
    ];
    const zh = translate("zh-CN");
    const en = translate("en-US");
    for (const [key, zhText, enText] of expected) {
      expect(zh(key), `zh-CN ${String(key)}`).toBe(zhText);
      expect(en(key), `en-US ${String(key)}`).toBe(enText);
    }
  });
});
