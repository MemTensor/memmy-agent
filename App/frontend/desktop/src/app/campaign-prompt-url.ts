import type { ResolvedLanguage } from "../i18n/messages.js";

/** Official activity page URL for the current app edition and language. */
export function getCampaignActivityUrl(language: ResolvedLanguage): string {
  const international = import.meta.env.MEMMY_APP_EDITION === "intl";
  const envKey = international ? "MEMMY_LEGAL_INTL_BASE_URL" : "MEMMY_LEGAL_CN_BASE_URL";
  const baseUrl = (international
    ? import.meta.env.MEMMY_LEGAL_INTL_BASE_URL
    : import.meta.env.MEMMY_LEGAL_CN_BASE_URL
  )?.trim();

  if (!baseUrl) {
    throw new Error(`${envKey} is required.`);
  }

  const localePrefix = international
    ? (language === "zh-CN" ? "cn/" : "")
    : (language === "en-US" ? "en/" : "");
  return new URL(`${localePrefix}activity/`, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}
