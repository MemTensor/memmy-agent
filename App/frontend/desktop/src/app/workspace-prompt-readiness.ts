import type { UserMode } from "@memmy/local-api-contracts";

const WORKSPACE_PATHS = new Set(["/main", "/memory", "/memory-sources", "/knowledge", "/tools", "/settings"]);

export function isWorkspacePromptSessionReady(input: {
  userMode: UserMode | null | undefined;
  accountUserId: string | null | undefined;
  byokConfigured?: boolean;
  guidanceDone?: boolean;
}): boolean {
  if (input.guidanceDone !== true) return false;
  if (input.userMode === "byok") return input.byokConfigured === true;
  return input.userMode === "account" && Boolean(input.accountUserId);
}

export function isGuidanceDone(input: {
  guidanceCompleted: boolean;
  onboardingCompleted: boolean;
  deferredGuidanceStep: string | null;
}): boolean {
  if (input.deferredGuidanceStep != null) return false;
  return input.guidanceCompleted || input.onboardingCompleted;
}

export function isWorkspacePromptSurfaceReady(input: { startupStatus: string; currentPath: string }): boolean {
  return input.startupStatus === "ready" && WORKSPACE_PATHS.has(input.currentPath);
}
