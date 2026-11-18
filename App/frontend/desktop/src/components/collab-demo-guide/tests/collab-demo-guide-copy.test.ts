/**
 * 说明卡上的字：一句都不能漏掉占位符。
 *
 * `formatMessage` 只替换传进来的那几项，没传的 `{name}` 会原样留在句子里。这里把每个子状态、
 * 两种语言的卡片都生成一遍，断言正文里不出现字面的 `{`；顺带把导览四步与那句无名字的文案钉住。
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
  "tour-associate",
  "tour-associate-pick",
  "tour-new-task",
  "task-row",
  "reader",
  "compose",
  "reply-waiting",
  "reply-done",
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
    done: { task: false },
    skipped: { task: false },
    scan: { status: "done", count: 12 },
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

  it("makes the continued task the last screen, with a done button", () => {
    // 接续成员的任务就是引导的最后一步：拿到回复之后主按钮直接收场。
    const zh = demoGuideCard(stateFor("reply-done"), translate("zh-CN"));
    expect(zh.action).toBe("done");
    expect(zh.step).toBe(1);
    expect(demoGuideCard(stateFor("complete"), translate("zh-CN")).action).toBeNull();
  });

  it("keeps four tour steps numbered one to four, without any raw placeholder", () => {
    // 导览四站：任务列表 → 关联任务 → 关联会话 → 新建任务，key 与序号一一对应。
    const zh = translate("zh-CN");
    const en = translate("en-US");
    expect([0, 1, 2, 3].map((index) => demoGuideTourCard(index, zh).stepName)).toEqual([
      "任务列表",
      "关联任务",
      "关联会话",
      "新建任务"
    ]);
    expect([0, 1, 2, 3].map((index) => demoGuideTourCard(index, en).stepName)).toEqual([
      "Task list",
      "Linked tasks",
      "Linked sessions",
      "New task"
    ]);
    for (const language of ["zh-CN", "en-US"] as const) {
      const t = translate(language);
      const cards = [0, 1, 2, 3].map((index) => demoGuideTourCard(index, t));
      for (const card of cards) {
        for (const text of [card.stepName, card.body]) {
          if (!text) continue;
          expect(text, `tour ${language}`).not.toContain("{");
          expect(text.length, `tour ${language}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("asks for the authorization on the link-session step before it can scan anything", () => {
    const zh = translate("zh-CN");
    // 没授权：弹窗只给授权说明，主按钮是「授权并查看」而不是「下一步」。
    const locked = demoGuideCard({ ...stateFor("tour-associate-pick"), scan: { status: "locked", count: 0 } }, zh);
    expect(locked.action).toBe("grant");
    expect(locked.actionDisabled).toBe(false);
    expect(locked.status).toBe("关联会话要读取这台电脑上的 Agent 记录，先授权一次即可。");

    // 授权中：同一个按钮置灰，不让人连点。
    const granting = demoGuideCard({ ...stateFor("tour-associate-pick"), scan: { status: "granting", count: 0 } }, zh);
    expect(granting.action).toBe("next");
    expect(granting.actionDisabled).toBe(true);
    expect(granting.status).toBe("正在接入这台电脑上的 Agent…");

    // 英文同步。
    const en = demoGuideCard({ ...stateFor("tour-associate-pick"), scan: { status: "locked", count: 0 } }, translate("en-US"));
    expect(en.action).toBe("grant");
    expect(en.status).toBe("Linking sessions reads this computer's agent history. Authorize once to look.");
  });

  it("holds the next button on the link-session step until the scan has a result", () => {
    const zh = translate("zh-CN");
    // 扫描中：按钮置灰，卡片写着正在扫，主按钮的字仍是「下一步」。
    const scanning = demoGuideCard({ ...stateFor("tour-associate-pick"), scan: { status: "scanning", count: 0 } }, zh);
    expect(scanning.actionDisabled).toBe(true);
    expect(scanning.status).toBe("正在扫描这台电脑上的历史会话…");
    expect(scanning.action).toBe("next");
    // 扫到会话：给出计数，按钮可用。
    const done = demoGuideCard({ ...stateFor("tour-associate-pick"), scan: { status: "done", count: 7 } }, zh);
    expect(done.actionDisabled).toBe(false);
    expect(done.status).toBe("已扫描到 7 个会话");
    // 一个也没扫到也算有了结果：不让按钮一直置灰。
    const empty = demoGuideCard({ ...stateFor("tour-associate-pick"), scan: { status: "done", count: 0 } }, zh);
    expect(empty.actionDisabled).toBe(false);
    expect(empty.status).toBe("这台电脑上暂时没有可以关联的会话。");
  });

  it("names the single experience step the way the prototype does", () => {
    const zh = translate("zh-CN")("collab.demo.stepName.1" as MessageKey);
    expect(zh).toBe("接续成员的任务");
    const en = translate("en-US")("collab.demo.stepName.1" as MessageKey);
    expect(en).toBe("Continue a member's task");
  });



  it("reads the scenario content from the cloud instead of writing its own", () => {
    // 剧本一句都不该在客户端写死：云端换了任务名与要接着做的事，卡片上的字跟着换。
    // 从前两边各写一份，云端改剧本后同一屏里会同时出现「项目协作上手清单」和「分享会通知」。
    const custom = {
      taskTitle: "下周五的团队分享会",
      taskNext: "写一段分享会的通知",
      askSentence: "查一下上次分享会一共来了多少人"
    };
    const t = translate("zh-CN");
    const state = (phase: DemoGuidePhase): DemoGuideState => ({ ...stateFor(phase), copy: custom });

    expect(demoGuideCard(state("task-row"), t).body).toContain("下周五的团队分享会");
    expect(demoGuideCard(state("reader"), t).body).toContain("写一段分享会的通知");
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
      ["collab.demo.collab.body", "开启后成员可以加入这个项目、共享任务；关闭后只作为你个人的本地项目。", "While it is on, members can join the project and share tasks; turned off, it is only your own local project."],
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
