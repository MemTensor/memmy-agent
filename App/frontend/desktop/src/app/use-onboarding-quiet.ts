/**
 * Waits for Memmy's existing new-user guidance to be over before the project-collaboration announcement may appear.
 *
 * A fresh account walks through the scan permission, the improvement program, the product tour and the nickname step,
 * and each of those writes the next step only once the previous one is answered. The onboarding also finishes slightly
 * before the first deferred step lands in storage, so "guidance done" alone can be true for one render right at that
 * hand-off. Showing the collaboration card in that gap stacks it on top of the improvement dialog, which is exactly the
 * collision the card has to avoid.
 *
 * Two things guard it: the card is only offered once the whole sequence is complete, and even then the screen has to
 * stay quiet for a few seconds — any guidance step or one-shot prompt appearing in the meantime restarts the clock.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { DeferredGuidanceStep } from "./routes.js";
import { isOnboardingPromptOpen, subscribeOnboardingPromptActivity } from "./onboarding-activity.js";
import { useGuidanceProgress } from "./use-guidance-progress.js";

/** How long the workspace has to stay quiet after the last guidance step before the announcement opens. */
export const ONBOARDING_QUIET_MS = 4_000;

/** Steps that put something on screen; `armed` only waits for a first sidebar click and shows nothing. */
const STEPS_ON_SCREEN: ReadonlySet<DeferredGuidanceStep> = new Set(["improvement", "product_tour", "nickname"]);

/** Whether the given step currently owns the screen. */
export function guidanceStepOnScreen(step: DeferredGuidanceStep | null | undefined): boolean {
  return step != null && STEPS_ON_SCREEN.has(step);
}

/**
 * Whether the existing guidance is finished.
 *
 * The machine-wide completion mark is written at the very end (after the nickname step), so it is the reliable answer.
 * An account that already finished onboarding elsewhere only has the cloud record; for those, a remaining step means
 * the walkthrough is still queued. `armed` is a leftover from older builds that no code writes any more — keeping it
 * would hold the announcement back forever, so it counts as "nothing left to show".
 */
export function existingGuidanceComplete(input: {
  guidanceCompleted: boolean;
  onboardingCompleted: boolean;
  deferredStep: DeferredGuidanceStep | null;
}): boolean {
  if (input.guidanceCompleted) return true;
  if (!input.onboardingCompleted) return false;
  return input.deferredStep === null || input.deferredStep === "armed";
}

type OnboardingQuiet = {
  /** The whole existing guidance sequence is over. */
  complete: boolean;
  /** A remaining step can still come up later: the walkthrough demo must not start now. */
  stepQueued: boolean;
  /** Nothing of the existing guidance is on screen, and has not been for {@link ONBOARDING_QUIET_MS}. */
  quiet: boolean;
};

/**
 * Reports whether the existing guidance is over and has left the screen alone for a while.
 *
 * `ready` is the caller's own "this card could be shown now" condition: the clock only runs while it holds, so a
 * route change or an already-seen record resets it instead of counting towards the next card.
 */
export function useOnboardingQuiet(input: {
  onboardingCompleted: boolean;
  ready: boolean;
  quietMs?: number;
}): OnboardingQuiet {
  const { guidanceCompleted, deferredGuidanceStep } = useGuidanceProgress();
  const promptOpen = useSyncExternalStore(
    subscribeOnboardingPromptActivity,
    isOnboardingPromptOpen,
    () => false
  );
  const complete = existingGuidanceComplete({
    guidanceCompleted,
    onboardingCompleted: input.onboardingCompleted,
    deferredStep: deferredGuidanceStep,
  });
  const stepOnScreen = guidanceStepOnScreen(deferredGuidanceStep);
  const busy = !complete || stepOnScreen || promptOpen;
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!input.ready || busy) {
      setSettled(false);
      return undefined;
    }
    // A fresh start every time the workspace gets busy again: the announcement waits for the full quiet window.
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), input.quietMs ?? ONBOARDING_QUIET_MS);
    return () => clearTimeout(timer);
  }, [busy, input.quietMs, input.ready]);

  return {
    complete,
    stepQueued: deferredGuidanceStep != null,
    quiet: input.ready && !busy && settled,
  };
}
