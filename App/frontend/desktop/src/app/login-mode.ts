/** Login mode module. */
import type { AppSettingsDto, OnboardingStateDto } from "@memmy/local-api-contracts";
import type { Dispatch } from "react";
import type { ConfigClient } from "../api/config-client.js";
import { appActions, type AppAction } from "../state/app-actions.js";

/** Contract for persist login mode selection input. */
export interface PersistLoginModeSelectionInput {
  configClient?: Pick<ConfigClient, "updateSettings" | "updateOnboarding">
    & Partial<Pick<ConfigClient, "getTokenUsage">>;
  dispatch: Dispatch<AppAction>;
  userMode: Extract<AppSettingsDto["userMode"], "account" | "byok">;
  onboarding?: Partial<OnboardingStateDto>;
}

/** Handles persist login mode selection. */
export async function persistLoginModeSelection(input: PersistLoginModeSelectionInput): Promise<void> {
  const settingsPatch = { userMode: input.userMode };
  const savedSettings = await saveSettingsPatch(input.configClient, settingsPatch);

  if (input.userMode === "account" && input.configClient?.getTokenUsage) {
    try {
      const tokenUsage = await input.configClient.getTokenUsage();
      input.dispatch(appActions.tokenUsageUpdated(tokenUsage));
    } catch (error) {
      // Quota synchronization failure must not block login. The unsynchronized
      // placeholder has lastSyncedAt=null, so it cannot trigger the exhausted modal.
      console.warn("refresh token usage after login failed", error);
    }
  }

  input.dispatch(appActions.settingsUpdated(savedSettings));

  if (!input.onboarding) {
    return;
  }

  const savedOnboarding = await saveOnboardingPatch(input.configClient, input.onboarding);
  input.dispatch(appActions.onboardingUpdated(savedOnboarding));
}

/** Writes save settings patch. */
async function saveSettingsPatch(
  configClient: PersistLoginModeSelectionInput["configClient"],
  settingsPatch: Partial<AppSettingsDto>
): Promise<Partial<AppSettingsDto>> {
  if (!configClient) {
    return settingsPatch;
  }

  return configClient.updateSettings(settingsPatch);
}

/** Writes save onboarding patch. */
async function saveOnboardingPatch(
  configClient: PersistLoginModeSelectionInput["configClient"],
  onboardingPatch: Partial<OnboardingStateDto>
): Promise<Partial<OnboardingStateDto>> {
  if (!configClient) {
    return onboardingPatch;
  }

  return configClient.updateOnboarding(onboardingPatch);
}
