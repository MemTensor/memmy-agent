export type DesktopPromptPreviewKind = "campaign" | "tokenCredit" | "history";

/** Dev-only query `?previewPrompt=campaign|tokenCredit|history|all` to force-show desktop prompts. */
export function isDesktopPromptPreview(kind: DesktopPromptPreviewKind): boolean {
  if (typeof window === "undefined" || !import.meta.env.DEV) {
    return false;
  }
  try {
    const preview = new URLSearchParams(window.location.search).get("previewPrompt");
    return preview === kind || preview === "all";
  } catch {
    return false;
  }
}
