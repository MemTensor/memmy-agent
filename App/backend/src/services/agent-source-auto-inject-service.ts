/** Agent source auto inject service module. */
import type { AgentSourceAutoInjectResult, ScanPreferences } from "@memmy/local-api-contracts";
import type { PermissionManager } from "../permission/index.js";
import type { AgentSourceService } from "./agent-source-service.js";

const AUTO_INJECT_AGENT_SOURCE_IDS = new Set(["cursor", "claude_code", "codex", "opencode", "openclaw", "hermes", "workbuddy"]);
const HOOK_OR_PLUGIN_AGENT_SOURCE_IDS = new Set(["cursor", "claude_code", "codex", "opencode", "openclaw", "hermes"]);

export interface AgentSourceAutoInjectService {
  runOnce(): Promise<AgentSourceAutoInjectResult>;
}

export interface CreateAgentSourceAutoInjectServiceOptions {
  agentSources: Pick<AgentSourceService, "list" | "installSkill" | "installPlugin">;
  permissionManager: Pick<PermissionManager, "canWriteAgentSkill">;
  getScanPreferences: () => ScanPreferences;
}

/** Creates create agent source auto inject service. */
export function createAgentSourceAutoInjectService(
  options: CreateAgentSourceAutoInjectServiceOptions
): AgentSourceAutoInjectService {
  let running = false;

  return {
    async runOnce() {
      if (running) {
        return {
          ok: true,
          skipped: true,
          reason: "already_running",
          installed: [],
          failed: []
        };
      }

      const preferences = options.getScanPreferences();
      if (!preferences.autoInjectSkill) {
        return {
          ok: true,
          skipped: true,
          reason: "auto_inject_disabled",
          installed: [],
          failed: []
        };
      }

      running = true;
      try {
        const sources = await options.agentSources.list();
        const installed: string[] = [];
        const failed: Array<{ sourceId: string; reason: string }> = [];

        for (const source of sources) {
          if (!AUTO_INJECT_AGENT_SOURCE_IDS.has(source.sourceId) || !source.builtin || !source.available || source.status !== "not_connected") {
            continue;
          }

          if (!(await options.permissionManager.canWriteAgentSkill({ agentSourceId: source.sourceId }))) {
            continue;
          }

          try {
            if (HOOK_OR_PLUGIN_AGENT_SOURCE_IDS.has(source.sourceId)) {
              await options.agentSources.installPlugin(source.sourceId);
            } else {
              await options.agentSources.installSkill(source.sourceId);
            }
            installed.push(source.sourceId);
          } catch (error) {
            failed.push({
              sourceId: source.sourceId,
              reason: error instanceof Error ? error.message : String(error)
            });
          }
        }

        return {
          ok: true,
          skipped: false,
          installed,
          failed
        };
      } finally {
        running = false;
      }
    }
  };
}
