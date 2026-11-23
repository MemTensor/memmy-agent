/**
 * 授权说明里列出的 Agent：图标 + 名字的小胶囊。
 *
 * 「关联会话」未授权时的那一屏用它，说明这一屏在讲哪些 Agent。
 */
import { agentSourceLogoUrl } from "./agent-source-logos.js";
import styles from "./collab-agent-chips.module.css";

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
