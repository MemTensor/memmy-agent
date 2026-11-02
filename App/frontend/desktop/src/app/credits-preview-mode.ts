/** Keeps the in-app credits UI behind an explicit preview URL until cloud credits exist. */
export function isCreditsPreviewMode(search = typeof window === "undefined" ? "" : window.location?.search ?? ""): boolean {
  return new URLSearchParams(search).get("credits-preview") === "1";
}

export function creditErrorScenario(search = typeof window === "undefined" ? "" : window.location?.search ?? ""): "agent" | "memory" | "knowledge" | null {
  if (!isCreditsPreviewMode(search)) return null;
  const value = new URLSearchParams(search).get("credits-error");
  return value === "agent" || value === "memory" || value === "knowledge" ? value : null;
}
