/** React subscribers observe local guide completion without waiting for a profile request. */
import { useSyncExternalStore } from "react";
import { isGuidanceDone } from "./workspace-prompt-readiness.js";
import {
  GUIDANCE_PROGRESS_EVENT,
  GUIDANCE_PROGRESS_STORAGE_KEY,
  readDeferredGuidanceStep,
  readGuidanceCompleted,
  type DeferredGuidanceStep,
} from "./routes.js";

function snapshot(): string {
  if (typeof window === "undefined") return "[false,null]";
  return JSON.stringify([
    readGuidanceCompleted(window.localStorage),
    readDeferredGuidanceStep(window.sessionStorage),
  ]);
}

function subscribe(changed: () => void): () => void {
  const storageChanged = (event: StorageEvent) => {
    if (event.storageArea === window.localStorage && (event.key === null
      || event.key === GUIDANCE_PROGRESS_STORAGE_KEY || event.key === "memmy.guidanceCompleted")) changed();
  };
  window.addEventListener(GUIDANCE_PROGRESS_EVENT, changed);
  window.addEventListener("storage", storageChanged);
  return () => {
    window.removeEventListener(GUIDANCE_PROGRESS_EVENT, changed);
    window.removeEventListener("storage", storageChanged);
  };
}

export function useGuidanceProgress(): {
  guidanceCompleted: boolean;
  deferredGuidanceStep: DeferredGuidanceStep | null;
} {
  const value = useSyncExternalStore(subscribe, snapshot, () => "[false,null]");
  const [guidanceCompleted, deferredGuidanceStep] = JSON.parse(value) as [boolean, DeferredGuidanceStep | null];
  return { guidanceCompleted, deferredGuidanceStep };
}

export function useGuidanceDone(onboardingCompleted: boolean): boolean {
  return isGuidanceDone({ ...useGuidanceProgress(), onboardingCompleted });
}
