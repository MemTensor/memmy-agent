/** Published application forms: one DingTalk Base per edition, one form per language. */
export const CREDIT_UPGRADE_FORMS = {
  "cn": {
    "zh-CN": "https://alidocs.dingtalk.com/notable/share/form/v01GXn4ZWgaXodwdODQ_Gb8aww9_hSDStju",
    "en-US": "https://alidocs.dingtalk.com/notable/share/form/v01GXn4ZWgaXodwdODQ_YEqI4bp_AaETHuL"
  },
  "intl": {
    "zh-CN": "https://alidocs.dingtalk.com/notable/share/form/v01M0OzX1dr5xk0Znze_B0FXaSH_hHxa07b",
    "en-US": "https://alidocs.dingtalk.com/notable/share/form/v01M0OzX1dr5xk0Znze_FAqe8nE_xKW8kbu"
  }
} as const;

export function getCreditUpgradeFormUrl(edition: string | undefined, language: string): string {
  const region = edition === "intl" ? "intl" : "cn";
  const locale = language === "en-US" ? "en-US" : "zh-CN";
  return CREDIT_UPGRADE_FORMS[region][locale];
}
