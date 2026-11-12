export type DesktopPromptPreviewKind = "collabLaunch";

/** Dev-only query `?previewPrompt=collabLaunch|all` to preview the collaboration announcement. */
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
