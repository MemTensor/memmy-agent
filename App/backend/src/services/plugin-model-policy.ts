/** Decides which model preset a plugin's inference calls may use. */
import type { AccountSessionView, ModelSelectionResolution, UserMode } from "@memmy/local-api-contracts";
import type { MemmyConfigWriter } from "../infrastructure/memmy-config/index.js";

export interface ResolvePluginModelSelectionInput {
  /** True when the plugin manifest declares `modelPolicy.requiredSource: "account"`. */
  accountOnly: boolean;
  userMode: UserMode | string;
  account: AccountSessionView;
  /** Exact preset selected for the conversation turn, if the call came from Agent. */
  requestedPreset?: string;
  resolveAssignedModel: MemmyConfigWriter["resolveAssignedModel"];
}

/**
 * Resolves the model preset a plugin may call, or null to deny the call.
 *
 * An account-only plugin is one the Host distributes and whose prompts are
 * sealed, so its traffic has to reach our gateway to be unsealed at all. Being
 * in account mode is not sufficient for that: account mode still permits BYOK
 * presets, which would send the request to a third-party endpoint. So the
 * resolved preset's own source is checked, not just the mode.
 *
 * @param input the plugin's policy, the current mode and account, and the preset resolver.
 * @returns the permitted preset, or null when the plugin may not call a model.
 */
export async function resolvePluginModelSelection(
  input: ResolvePluginModelSelectionInput
): Promise<ModelSelectionResolution | null> {
  const activeAccountId = input.account.authenticated ? input.account.profile.userId : null;

  if (input.accountOnly) {
    if (input.userMode !== "account" || !activeAccountId) return null;
    const preset = await input.resolveAssignedModel?.({
      mode: "account",
      activeAccountId,
      capability: "agent",
      ...(input.requestedPreset ? { requestedPreset: input.requestedPreset } : {})
    });
    return preset?.ok && preset.context.source === "account" ? preset : null;
  }

  if (input.userMode !== "account" && input.userMode !== "byok") return null;
  return await input.resolveAssignedModel?.({
    mode: input.userMode,
    activeAccountId,
    capability: "agent",
    ...(input.requestedPreset ? { requestedPreset: input.requestedPreset } : {})
  }) ?? null;
}
