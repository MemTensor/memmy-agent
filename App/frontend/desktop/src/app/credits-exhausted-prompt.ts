/** Shared preview signal for the credits-exhausted dialog across app pages. */
export const CREDITS_EXHAUSTED_PROMPT_EVENT = "memmy:credits-exhausted-prompt";

export function requestCreditsExhaustedPrompt(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CREDITS_EXHAUSTED_PROMPT_EVENT));
  }
}

/** URL-only preview trigger; never opens the dialog in the ordinary product. */
export function hasCreditsExhaustedPreview(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get("credits-preview") === "1" && params.has("credits-exhausted");
}
