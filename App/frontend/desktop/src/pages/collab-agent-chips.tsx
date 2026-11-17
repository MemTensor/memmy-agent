/**
 * 授权说明里列出的 Agent：图标 + 名字的小胶囊。
 *
 * 授权弹窗与「关联任务」的授权说明共用它，保证两处看到的范围、样式一致。
 */
import { agentSourceLogoUrl } from "./agent-source-logos.js";
import styles from "./collab-agent-access.module.css";

export interface CollabAgentChipItem {
  sourceId: string;
  name: string;
}

export function CollabAgentChips(props: { agents: readonly CollabAgentChipItem[]; className?: string }) {
  if (!props.agents.length) return null;
  return (
    <div className={`${styles.chips} ${props.className ?? ""}`.trim()}>
      {props.agents.map((agent) => {
        const logo = agentSourceLogoUrl(agent.sourceId);
        return (
          <span key={agent.sourceId} className={styles.chip}>
            {logo ? <img className={styles.chipLogo} src={logo} alt="" /> : <span className={styles.chipMark}>{Array.from(agent.name)[0] ?? "A"}</span>}
            {agent.name}
          </span>
        );
      })}
    </div>
  );
}

/**
 * 这个 Agent 会装上什么：协作项目的技能总是会装，钩子里的项目部分只在
 * 记忆接入也有钩子的那几个 Agent 上存在。
 */
export function collabAgentParts(sourceId: string): "hook" | "skill" {
  return HOOK_AGENTS.has(sourceId) ? "hook" : "skill";
}

/** 记忆接入里带 memmy-resume-hook 的来源；协作的背景与规范注入放在这个钩子里。 */
const HOOK_AGENTS = new Set(["claude_code", "codex", "cursor"]);
