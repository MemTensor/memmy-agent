/** Endpoints module. */

/** Definition for legal page path. */
export const LEGAL_PAGE_PATH = "/api/memmy/desktop/legal/page";

/** Handles legal page url. */
export function legalPageUrl(base: string, kind: "terms" | "data", language: "zh-CN" | "en-US"): string {
  return `${base}${LEGAL_PAGE_PATH}?type=${kind}&lang=${encodeURIComponent(language)}`;
}
