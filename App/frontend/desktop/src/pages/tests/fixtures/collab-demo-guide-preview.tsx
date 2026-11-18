/**
 * 新手引导的预览页：按 `step` 摆出某一屏的样子（见 {@link DEMO_GUIDE_PREVIEW_STEPS}）。
 *
 * 用一套假的项目与成员数据摆出看板、只读面板与输入框，再把真正的蒙版画在上面，
 * 这样不连本机接口也能逐步检查亮区位置、说明卡会不会挡住目标、窄窗口下是否溢出。
 */
import type { CSSProperties, ReactNode } from "react";
import { Link2, MessageSquarePlus, Search, Settings, UserPlus } from "lucide-react";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { CollabDemoGuideOverlay } from "../../../components/collab-demo-guide/collab-demo-guide-overlay.js";
import { demoGuideIsTourPhase, type DemoGuidePhase, type DemoGuideState } from "../../../app/collab-demo-guide-store.js";
import board from "../../collab-page.module.css";

/**
 * 预览里的步骤：卡片上的名字与 {@link DemoGuidePhase} 一一对应。
 *
 * `0-*` 是建项目之前的那一段（新建弹窗上的六屏，加上加入项目之后看板上的成员亮区），`t-*` 是四步看板导览
 * （纯介绍），`1-*` 是体验段的那一步。
 */
export const DEMO_GUIDE_PREVIEW_STEPS = {
  "0-intro": "intro",
  "0-name": "name",
  "0-folder": "folder",
  "0-collab": "collab",
  "0-join-entry": "join-entry",
  "0-create-project": "create-project",
  "0-joined": "joined",
  "t-board": "tour-board",
  "t-associate": "tour-associate",
  "t-associate-pick": "tour-associate-pick",
  // 同一站、还没授权：弹窗是授权说明，「下一步」换成「授权并查看」。
  "t-associate-lock": "tour-associate-pick",
  "t-new-task": "tour-new-task",
  "1-task-row": "task-row",
  "1-reader": "reader",
  "1-compose": "compose",
  "1-waiting": "reply-waiting",
  "1-done": "reply-done"
} as const satisfies Record<string, DemoGuidePhase>;

export type DemoGuidePreviewStep = keyof typeof DEMO_GUIDE_PREVIEW_STEPS | "complete" | "error";

const MEMBER = "小饭团";

/**
 * 建项目之前的那些阶段：还没有云端项目，也还不知道演示成员是谁，卡片这时用中性叫法。
 * 前五个在新建弹窗上，`create-project` 停在弹窗的「创建项目」按钮上。
 */
const PRE_PROJECT_PHASES: readonly DemoGuidePhase[] = [
  "intro",
  "name",
  "folder",
  "collab",
  "join-entry",
  "create-project"
];

function stateFor(step: DemoGuidePreviewStep): DemoGuideState {
  const phase = step === "complete" || step === "error"
    ? (step === "complete" ? "complete" : "reply-waiting")
    : DEMO_GUIDE_PREVIEW_STEPS[step];
  const beforeProject = PRE_PROJECT_PHASES.includes(phase);
  return {
    status: step === "complete" ? "complete" : "active",
    phase,
    projectId: beforeProject ? null : "preview-cloud",
    localProjectId: beforeProject ? null : "preview-local",
    memberUserId: beforeProject ? null : "9001",
    memberName: beforeProject ? "" : MEMBER,
    error: step === "error" ? "Agent 没有给出回复。" : null,
    done: { task: step === "complete" },
    skipped: { task: false },
    // 「关联会话」那一屏：预览里直接摆扫完的样子（列表 + 计数），主按钮可用；`t-associate-lock` 摆未授权的样子。
    scan: phase === "tour-associate-pick"
      ? (step === "t-associate-lock" ? { status: "locked", count: 0 } : { status: "done", count: 12 })
      : { status: "idle", count: 0 },
    prefill: null,
    endReason: step === "complete" ? "finished" : null,
    cloudEnded: false
  };
}

const card: CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  boxShadow: "0 1px 2px rgba(16,26,25,.06)"
};

/**
 * 侧栏：真实客户端里它在看板左边，项目名一行右侧就是「＋新建任务」。
 * 只有导览讲到「侧栏新建任务」时才摆出来，其他步骤的截图仍按原来的满宽看板。
 */
function PreviewSidebar() {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: 216,
        padding: "18px 10px",
        background: "color-mix(in srgb, #f4f7f6 70%, #fff)",
        borderRight: "1px solid rgba(16,26,25,.06)"
      }}
    >
      <div style={{ fontSize: 12, color: "rgba(16,26,25,.42)", padding: "0 8px 8px" }}>项目</div>
      <div className="app-frame-project-row" style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 8, background: "rgba(16,26,25,.05)" }}>
        <span aria-hidden="true" style={{ fontSize: 12, color: "rgba(16,26,25,.5)" }}>▾</span>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          项目协作体验
        </span>
        <button
          type="button"
          aria-label="新建任务"
          data-demo-guide="sidebar-new-task"
          className="task-icon-button"
          style={{ width: 24, height: 24, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 8, border: 0, background: "transparent", cursor: "pointer" }}
        >
          <MessageSquarePlus size={14} aria-hidden="true" />
        </button>
      </div>
      <div style={{ marginTop: 10, fontSize: 12.5, color: "rgba(16,26,25,.5)", padding: "0 8px" }}>下周五的团队分享会</div>
    </div>
  );
}

/** 看板的一列：标题、任务行、右侧项目配置，与真实看板同一套类名与外观。 */
function BoardSurface(props: { withSidebar?: boolean; withMembersAnchor?: boolean }) {
  return (
    <div
      className={board.page}
      data-demo-guide="board-main"
      style={{
        position: "absolute",
        inset: props.withSidebar ? "0 0 0 216px" : 0,
        background: "var(--color-canvas-oat, #f4f7f6)"
      }}
    >
      <div className={board.scroller}>
        <div className={board.wrap}>
          <header className={board.boardHeader}>
            <span className={board.boardIcon} aria-hidden="true">☁</span>
            <h1 className={board.boardName}>项目协作体验</h1>
            <span className={board.boardScope} {...(props.withMembersAnchor ? { "data-demo-guide": "board-members" } : {})}>2 位成员</span>
            <span className={board.grow} />
            <button type="button" className="button button-ghost button-sm">
              <UserPlus size={15} aria-hidden="true" />邀请
            </button>
            <button type="button" className="button button-ghost button-sm" aria-label="项目设置" data-demo-guide="board-settings">
              <Settings size={15} aria-hidden="true" />
            </button>
          </header>
          <div className={board.boardTabs} role="tablist" data-demo-guide="board-tabs">
            <button type="button" role="tab" aria-selected className={`${board.boardTab} ${board.boardTabOn}`}>任务</button>
            <button type="button" role="tab" aria-selected={false} className={board.boardTab}>归档</button>
          </div>
          <div className={board.toolbar}>
            <label className={board.searchBox}>
              <Search size={14} aria-hidden="true" className={board.searchIcon} />
              <input readOnly placeholder="搜索任务" className={board.search} />
            </label>
            <span className={board.grow} />
            {/* 「关联任务」：看板导览那一站亮起来的地方。 */}
            <button type="button" className="button button-primary button-sm" data-demo-guide="board-associate">
              <Link2 size={14} aria-hidden="true" />关联任务
            </button>
          </div>
          {/* 导览第一步只框任务列表那一片。 */}
          <ul className={`${board.list} ${board.stream} ${board.flatStream}`} data-demo-guide="board-list">
            <li className={`${board.row} ${board.rowOpenable}`} data-demo-guide="board-task-row">
              <span className={`${board.avatar} ${board.avatarSoft}`} style={{ "--member": "#8fb6ae" } as CSSProperties} aria-hidden="true">
                小
              </span>
              <div className={board.rowText}>
                <span className={board.rowTitle}>下周五的团队分享会</span>
                <span className={board.rowSummary}>下周五下午想办一次团队分享会，主题是用 Agent 管好团队的上下文，大概 25 人。</span>
              </div>
              <span className={board.meta}>{MEMBER} · 10:24</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * 新建项目弹窗：体验入口的样子——名称已填好、协作开关已打开，底部「创建项目」是蒙版唯一亮起的控件。
 * 弹窗交出自己的暗底（见 DEMO_GUIDE_YIELD_BACKDROP），否则蒙版下面会叠两层灰。
 *
 * 建项目之前的六个阶段都摆这个弹窗：`intro` 框整个弹窗，其余四个框到名称、文件夹、协作开关与左下角的
 * 「加入项目」，`create-project` 框底部按钮。锚点与真实弹窗的 `data-demo-guide` 一一对应。
 */
function CreateProjectSurface() {
  const field: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    height: 44,
    padding: "0 12px",
    border: "1px solid rgba(16,26,25,.14)",
    borderRadius: 10,
    background: "#fff",
    fontSize: 13.5
  };
  return (
    <div
      data-demo-guide-yield-backdrop=""
      style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div
        className={board.simpleCreateModal}
        data-demo-guide="create-dialog"
        style={{ width: 520, background: "#fff", borderRadius: 16, padding: "20px 22px 16px" }}
      >
        <b style={{ fontSize: 15 }}>新建项目</b>
        <div data-demo-guide="create-name" style={{ marginTop: 16, ...field }}>
          <span style={{ color: "rgba(16,26,25,.4)" }} aria-hidden="true">▣</span>
          <span style={{ flex: 1 }}>项目协作体验</span>
        </div>
        <div className={board.simpleSectionLabel}>文件夹</div>
        <div className={board.simpleFolderBox} data-demo-guide="create-folder">
          <div className={board.simpleFolderEmpty}>
            <span>还没有选文件夹，创建时会为你新建一个</span>
          </div>
        </div>
        <div
          data-demo-guide="create-collab"
          style={{ ...field, height: 40, marginTop: 8, border: "none", borderRadius: 8, background: "transparent" }}
        >
          <span style={{ color: "#2f8f7f" }} aria-hidden="true">◉</span>
          <span style={{ flex: 1 }}>开启项目协作</span>
          <button type="button" role="switch" aria-checked="true" aria-label="开启项目协作" className={board.settingsSwitchOn} />
        </div>
        {/* 左下是「加入项目」，右下是取消与创建：与真实弹窗的页脚一致（三个按钮同一尺寸）。 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 20 }}>
          <button
            type="button"
            className={`button button-secondary ${board.simpleCreateFooterButton}`}
            data-demo-guide="create-join"
          >
            加入项目
          </button>
          <span style={{ display: "flex", gap: 8 }}>
            <button type="button" className={`button button-ghost ${board.simpleCreateFooterButton}`}>取消</button>
            <button
              type="button"
              className={`button button-primary ${board.simpleCreateFooterButton}`}
              data-demo-guide="create-project-submit"
            >
              创建项目
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/** 右侧的只读任务面板：头部有「继续任务」，正文两轮对话。 */
function ReaderSurface() {
  return (
    <div
      className={board.readerPanel}
      data-demo-guide="reader-panel"
      // 舞台里绝对定位、写死高度：截图时窗口尺寸怎么变，量出来的位置都是同一个。
      style={{ position: "absolute", right: 28, top: 76, bottom: 24, width: 420 }}
    >
      <header className={board.readerHead}>
        <span className={`${board.avatar} ${board.avatarSoft} ${board.readerHeadAvatar}`} style={{ "--member": "#8fb6ae" } as CSSProperties} aria-hidden="true">
          小
        </span>
        <div className={board.readerHeadText}>
          <h2 className={board.readerTitle}>下周五的团队分享会</h2>
          <div className={board.readerHeadMeta}>
            <span>{MEMBER} · 今天 10:24</span>
            <span className={board.readerBadge}>只读</span>
          </div>
        </div>
        <div className={board.readerActions}>
          <button type="button" className={board.readerContinue} data-demo-guide="reader-continue">继续任务</button>
        </div>
      </header>
      <div className={board.readerBody}>
        <article className={board.readerTurn}>
          <span className={board.readerTurnIndex}>第 1 轮</span>
          <div className={board.readerUser} data-collab-role="user">
            <p className={board.readerUserBubble}>
              下周五下午想办一次团队分享会，主题是用 Agent 管好团队的上下文，大概 25 人。三楼哪个会议室合适？议程也帮我排一下。
            </p>
          </div>
          <div className={board.readerAgent} data-collab-role="agent">
            <div className={board.readerAgentHead}>
              <span className={board.readerAgentMark} aria-hidden="true">M</span>
              <span>Memmy</span>
            </div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-line" }}>
              {"三楼大会议室能坐 30 人，有投屏，下周五 15:00–16:00 空闲；小会议室只能坐 12 人。\n\n议程建议：15:00 演示，15:10 主题分享，主讲小饭团，15:40 问答。还剩两件事：把通知发给团队，收集报名。"}
            </p>
          </div>
        </article>
      </div>
    </div>
  );
}

/** 对话页：输入框、发送按钮与对话区。 */
function ChatSurface(props: { phase: DemoGuidePhase }) {
  const waiting = props.phase === "reply-waiting";
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--color-canvas-oat, #f4f7f6)" }}>
      <div style={{ flex: 1, overflow: "auto", padding: "40px 56px" }} data-demo-guide="conversation">
        <div style={{ ...card, padding: 18, marginBottom: 14 }}>
          <b style={{ fontSize: 13 }}>你</b>
          <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.6 }}>接着小饭团的安排，写一段分享会的通知</p>
        </div>
        <div style={{ ...card, padding: 18 }}>
          <b style={{ fontSize: 13 }}>Memmy</b>
          <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.6 }}>
            {waiting
              ? "正在读取小饭团的任务…"
              : "分享会通知已写好：\n\n下周五 15:00，三楼大会议室，有投屏。\n\n议程：15:00 演示，15:10 主题分享（主讲小饭团），15:40 问答。\n\n请回复是否参加，方便统计报名。"}
          </p>
        </div>
      </div>
      <div style={{ padding: "0 56px 40px" }}>
        <div
          data-demo-guide="composer"
          style={{ ...card, border: "1px solid rgba(16,26,25,.08)", padding: "16px 16px 46px", position: "relative" }}
        >
          <p style={{ margin: 0, fontSize: 13, color: "rgba(16,26,25,.62)" }}>
            {"接着小饭团的安排，写一段分享会的通知"}
          </p>
          <button type="button" className="composer-action-submit" data-demo-guide="composer-send" style={{ position: "absolute", right: 14, bottom: 12 }}>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 关联会话弹窗：标题、Agent 列与扫出来的会话列表；展示模式没有底部。
 *
 * 真实组件还连本机接口真扫；预览只摆布局与亮区锚点，名字与真实弹窗的 `data-demo-guide` 一致。
 */
function AssociatePickSurface({ locked = false }: { locked?: boolean }) {
  const rows = [
    { title: "把分享会的议程拆成待办", meta: "10:24" },
    { title: "核对上次分享会的签到表", meta: "昨天" },
    { title: "给看板加上成员筛选", meta: "周一" }
  ];
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <section
        data-demo-guide="associate-pick"
        style={{ width: 560, background: "#fff", borderRadius: 16, boxShadow: "0 18px 44px rgba(16,26,25,.18)", overflow: "hidden" }}
      >
        <header style={{ padding: "16px 18px 10px" }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>管理其他 Agent 的任务</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, lineHeight: 1.6, color: "rgba(16,26,25,.55)" }}>
            所选任务将同步至「项目协作体验」，对项目成员可见；取消关联不会删除本地任务。
          </p>
        </header>
        {locked ? (
          <div style={{ padding: "18px 18px 22px", textAlign: "center" }}>
            <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600 }}>允许 Memmy 读取本机 Agent 的任务？</p>
            <p style={{ margin: "6px 0 0", fontSize: 12.5, lineHeight: 1.7, color: "rgba(16,26,25,.55)" }}>
              读取这台电脑上 Claude Code、Cursor 等 Agent 的任务，供你关联到项目；只共享你选中的任务。
            </p>
          </div>
        ) : (
        <div style={{ display: "flex", gap: 12, padding: "4px 18px 12px" }}>
          <nav style={{ width: 148, display: "flex", flexDirection: "column", gap: 2 }} aria-label="Agent">
            {["Claude Code", "Cursor"].map((agent, index) => (
              <div
                key={agent}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "7px 8px",
                  borderRadius: 8,
                  fontSize: 12.5,
                  background: index === 0 ? "rgba(92,191,174,.12)" : "transparent"
                }}
              >
                {agent}
              </div>
            ))}
          </nav>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ height: 32, borderRadius: 8, border: "1px solid rgba(16,26,25,.1)", display: "flex", alignItems: "center", padding: "0 10px", fontSize: 12, color: "rgba(16,26,25,.45)", marginBottom: 8 }}>
              搜索 Claude Code 的会话
            </div>
            {rows.map((row) => (
              <div key={row.title} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 12.5 }}>
                <span style={{ width: 14, height: 14, borderRadius: 4, border: "1px solid rgba(16,26,25,.22)" }} aria-hidden="true" />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.title}</span>
                <span style={{ fontSize: 11.5, color: "rgba(16,26,25,.45)" }}>{row.meta}</span>
              </div>
            ))}
            <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "rgba(16,26,25,.45)" }}>{`共 ${rows.length} 个会话`}</p>
          </div>
        </div>
        )}

      </section>
    </div>
  );
}

/**
 * 舞台尺寸：写死的盒子，锚点全在里面，量出来的位置不随截图窗口的缩放变。
 * 默认按 1280 宽、713 高（这块 Chrome 的布局视口比窗口矮 87），窄窗口用 `?w=&h=` 指定。
 */
export function demoGuidePreviewStage(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1280, height: 713 };
  const params = new URLSearchParams(window.location.search);
  const read = (key: string, fallback: number) => {
    const value = Number.parseInt(params.get(key) ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return { width: read("w", 1280), height: read("h", 713) };
}

export function DemoGuidePreview(props: { step: DemoGuidePreviewStep }) {
  const state = stateFor(props.step);
  const stage = demoGuidePreviewStage();

  const phase = state.phase;
  const chat = phase === "compose" || phase === "reply-waiting" || phase === "reply-done";
  // 看板导览的四步：只摆看板（「关联会话」多一张弹窗，最后一步多一条侧栏），不换页。
  const tour = demoGuideIsTourPhase(phase);
  let surface: ReactNode;
  // 建项目之前的六个阶段全在新建弹窗上，只换亮区。
  if (PRE_PROJECT_PHASES.includes(phase)) surface = <CreateProjectSurface />;
  // 加入之后人已经在看板上：亮区只套住头部的成员徽章，没有独立的提示窗。
  else if (phase === "joined") surface = <BoardSurface withMembersAnchor />;
  else if (chat) surface = <ChatSurface phase={phase} />;
  else if (tour) {
    surface = (
      <>
        <BoardSurface withSidebar={phase === "tour-new-task"} />
        {phase === "tour-new-task" ? <PreviewSidebar /> : null}
        {phase === "tour-associate-pick" ? <AssociatePickSurface locked={props.step === "t-associate-lock"} /> : null}
      </>
    );
  }
  else if (phase === "reader") surface = (<><BoardSurface /><ReaderSurface /></>);
  else surface = <BoardSurface />;

  return (
    <I18nProvider language="zh-CN">
      {/* 固定大小的盒子：位置可复现，蒙版按它里面的锚点来画。 */}
      <div style={{ position: "fixed", left: 0, top: 0, width: stage.width, height: stage.height, overflow: "hidden" }}>
        {surface}
        <CollabDemoGuideOverlay
          state={state}
          onNext={() => undefined}
          onSkip={() => undefined}
          onExit={() => undefined}
          onRetry={() => undefined}
          onCloseComplete={() => undefined}
          onInvite={() => undefined}
          // 「加入项目」不在弹窗里时，界面自己报一下，状态机跳过那一屏。
          onSkipJoinEntry={() => undefined}
        />
      </div>
    </I18nProvider>
  );
}
