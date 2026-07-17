import type { ResolvedLanguage } from "../i18n/messages.js";
import type { LegalAgreementUrls } from "@memmy/local-api-contracts";

export type { LegalAgreementUrls } from "@memmy/local-api-contracts";

export type LegalDocumentKind = "terms" | "data";

export function getLegalLinkUrl(
  kind: LegalDocumentKind,
  language: ResolvedLanguage,
  _remote?: LegalAgreementUrls
): string {
  const international = import.meta.env.MEMMY_APP_EDITION === "intl";
  const envKey = international ? "MEMMY_LEGAL_INTL_BASE_URL" : "MEMMY_LEGAL_CN_BASE_URL";
  const baseUrl = (international
    ? import.meta.env.MEMMY_LEGAL_INTL_BASE_URL
    : import.meta.env.MEMMY_LEGAL_CN_BASE_URL
  )?.trim();

  if (!baseUrl) {
    throw new Error(`${envKey} is required.`);
  }

  const documentPath = kind === "data" ? "privacy" : "terms";
  const languagePath = language === "zh-CN" ? "" : "en/";
  return new URL(`${documentPath}/${languagePath}`, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}
