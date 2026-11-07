/** Agent source auto inject service module. */
import type { AgentSourceAutoInjectResult, AgentSourceView, ScanPreferences } from "@memmy/local-api-contracts";
import type { PermissionManager } from "../permission/index.js";
import type { AgentSourceService } from "./agent-source-service.js";

const AUTO_INJECT_AGENT_SOURCE_IDS = new Set([
  "cursor",
  "claude_code",
  "codex",
  "opencode",
  "openclaw",
  "hermes",
  "deepseek_harness",
  "workbuddy",
  "pi",
  "qwenwork"
]);
const HOOK_OR_PLUGIN_AGENT_SOURCE_IDS = new Set(["cursor", "claude_code", "codex", "opencode", "openclaw", "hermes", "deepseek_harness"]);
const UPDATABLE_HOOK_AGENT_SOURCE_IDS = new Set(["cursor", "claude_code", "codex", "opencode"]);

export interface AgentSourceAutoInjectService {
  runOnce(): Promise<AgentSourceAutoInjectResult>;
  reconcilePermission?(): Promise<void>;
}

export interface CreateAgentSourceAutoInjectServiceOptions {
  agentSources: Pick<AgentSourceService, "list" | "installSkill" | "installPlugin" | "isInstalledHookCurrent">
    & Partial<Pick<AgentSourceService, "uninstallSkill" | "uninstallPlugin" | "isAutomaticConnectionAllowed">>;
  permissionManager: Pick<PermissionManager, "canWriteAgentSkill">;
  getScanPreferences: () => ScanPreferences;
  isScanAllowed?: () => boolean;
  isAutoInjectSuppressed?: (sourceId: string) => boolean;
}

/** Creates create agent source auto inject service. */
export function createAgentSourceAutoInjectService(
  options: CreateAgentSourceAutoInjectServiceOptions
): AgentSourceAutoInjectService {
  let running = false;
  let generation = 0;
  let completion: Promise<void> | undefined;

  return {
    async reconcilePermission() { generation += 1; await completion; },
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

      running = true;
      let finish!: () => void;
      completion = new Promise<void>(resolve => { finish = resolve; });
      const ownGeneration = generation;
      const isCurrent = () => ownGeneration === generation && options.isScanAllowed?.() !== false;
      const assertCurrent = () => { if (!isCurrent()) throw new Error("Automatic integration permission revoked"); };
      const isSourceAllowed = async (sourceId: string) => options.agentSources.isAutomaticConnectionAllowed
        ? options.agentSources.isAutomaticConnectionAllowed(sourceId)
        : !options.isAutoInjectSuppressed?.(sourceId);
      const confirmInstalled = async (sourceId: string, kind: "plugin" | "skill", assertAllowed: () => void) => {
        let authorityError: unknown;
        try {
          assertAllowed();
          if (await isSourceAllowed(sourceId)) { assertAllowed(); return true; }
        }
        catch (error) { authorityError = error; }
        try {
          if (kind === "plugin") {
            if (!options.agentSources.uninstallPlugin) throw new Error("Cannot clean up an automatic integration");
            await options.agentSources.uninstallPlugin(sourceId, { installType: "auto_inject" });
          } else {
            if (!options.agentSources.uninstallSkill) throw new Error("Cannot clean up an automatic integration");
            await options.agentSources.uninstallSkill(sourceId, { installType: "auto_inject" });
          }
        } catch (cleanupError) {
          throw new AggregateError([authorityError, cleanupError].filter(Boolean), "Automatic integration could not be confirmed. Cleanup failed. Retry removal.");
        }
        if (authorityError) throw authorityError;
        return false;
      };
      const assertInstallAllowed = () => { assertCurrent(); if (!options.getScanPreferences().autoInjectSkill) throw new Error("Automatic integration disabled"); };
      try {
        if (!isCurrent()) return { ok: true, skipped: true, reason: "auto_inject_disabled", installed: [], failed: [] };
        const sources = await options.agentSources.list();
        const installed: string[] = [];
        const failed: Array<{ sourceId: string; reason: string }> = [];

        for (const source of sources) {
          if (!isCurrent()) break;
          if (!isUpdatableInstalledHook(source)) continue;
          try {
            if (!(await isSourceAllowed(source.sourceId))) continue;
            if (!(await options.permissionManager.canWriteAgentSkill({ agentSourceId: source.sourceId }))) {
              continue;
            }

            if (await options.agentSources.isInstalledHookCurrent(source.sourceId)) continue;
            assertCurrent();
            if (!(await isSourceAllowed(source.sourceId))) continue;
            await options.agentSources.installPlugin(source.sourceId, { installType: "auto_inject" }, assertCurrent);
            if (!(await confirmInstalled(source.sourceId, "plugin", assertCurrent))) continue;
            installed.push(source.sourceId);
          } catch (error) {
            failed.push({
              sourceId: source.sourceId,
              reason: error instanceof Error ? error.message : String(error)
            });
          }
        }

        const preferences = options.getScanPreferences();
        if (!preferences.autoInjectSkill) {
          return {
            ok: true,
            skipped: true,
            reason: "auto_inject_disabled",
            installed,
            failed
          };
        }

        for (const source of sources) {
          if (!isCurrent()) break;
          if (!AUTO_INJECT_AGENT_SOURCE_IDS.has(source.sourceId) || !source.builtin || !source.available || source.status !== "not_connected") {
            continue;
          }

          try {
            if (!(await isSourceAllowed(source.sourceId))) continue;
            if (!(await options.permissionManager.canWriteAgentSkill({ agentSourceId: source.sourceId }))) {
              continue;
            }

            assertInstallAllowed();
            if (!(await isSourceAllowed(source.sourceId))) continue;
            if (HOOK_OR_PLUGIN_AGENT_SOURCE_IDS.has(source.sourceId)) {
              await options.agentSources.installPlugin(source.sourceId, { installType: "auto_inject" }, assertInstallAllowed);
            } else {
              await options.agentSources.installSkill(source.sourceId, { installType: "auto_inject" }, assertInstallAllowed);
            }
            if (!(await confirmInstalled(source.sourceId, HOOK_OR_PLUGIN_AGENT_SOURCE_IDS.has(source.sourceId) ? "plugin" : "skill", assertInstallAllowed))) continue;
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
        finish();
        completion = undefined;
      }
    }
  };
}

function isUpdatableInstalledHook(source: AgentSourceView): boolean {
  return UPDATABLE_HOOK_AGENT_SOURCE_IDS.has(source.sourceId)
    && source.builtin
    && source.available
    && source.status === "plugin_installed";
}
