/**
 * Registry of Memmy's own first-run prompts (the large cards, the gift notice, the star prompt) while they hold the
 * screen.
 *
 * The project-collaboration announcement queues behind the existing new-user guidance: a fresh install shows the scan
 * permission, the improvement program, the product tour and the nickname step one after another, and the other one-shot
 * prompts follow whenever their own conditions hold. Deciding whether it is finally the collaboration card's turn needs
 * to know if anything else just appeared, so each prompt records itself while it is open and clears the record when it
 * closes.
 *
 * Only presence matters here, not who: one prompt closing must never release another one's slot.
 */

const openPrompts = new Set<string>();
const listeners = new Set<() => void>();

/** Records a prompt's visibility; no subscriber is bothered when nothing changed. */
export function reportOnboardingPromptOpen(owner: string, open: boolean): void {
  const known = openPrompts.has(owner);
  if (known === open) return;
  if (open) openPrompts.add(owner);
  else openPrompts.delete(owner);
  for (const listener of listeners) listener();
}

/** Whether any existing first-run prompt is on screen right now. */
export function isOnboardingPromptOpen(): boolean {
  return openPrompts.size > 0;
}

/** Subscribes to prompt visibility outside the React tree. */
export function subscribeOnboardingPromptActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forgets every prompt registered in this run. */
export function resetOnboardingPromptActivity(): void {
  openPrompts.clear();
  listeners.clear();
}
