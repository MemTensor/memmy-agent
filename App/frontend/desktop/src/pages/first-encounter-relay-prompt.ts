import { enUSMessages, zhCNMessages, type ResolvedLanguage } from "../i18n/messages.js";

export function buildFirstEncounterRelayPrompt(
  language: ResolvedLanguage,
  workspacePath: string | null | undefined
): string {
  const messages = language === "zh-CN" ? zhCNMessages : enUSMessages;
  const path = workspacePath?.trim();
  if (!path) {
    return messages["onboarding.relay.prompt"];
  }
  return messages["onboarding.relay.promptWithWorkspace"].replace("{workspacePath}", path);
}
