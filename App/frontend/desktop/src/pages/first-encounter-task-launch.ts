export const PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY = "memmy.pendingFirstEncounterTaskLaunch";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PendingFirstEncounterTaskLaunch {
  prompt: string;
  createdAt: number;
}

export function writePendingFirstEncounterTaskLaunch(storage: StorageLike | null | undefined, prompt: string, now = Date.now()): void {
  const trimmedPrompt = prompt.trim();
  if (!storage || !trimmedPrompt) {
    return;
  }

  storage.setItem(PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY, JSON.stringify({
    prompt: trimmedPrompt,
    createdAt: now
  } satisfies PendingFirstEncounterTaskLaunch));
}

/** Clears a pending report task so entering a blank conversation cannot auto-send stale content. */
export function clearPendingFirstEncounterTaskLaunch(storage: StorageLike | null | undefined): void {
  storage?.removeItem(PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY);
}

export function consumePendingFirstEncounterTaskLaunch(storage: StorageLike | null | undefined): string | null {
  if (!storage) {
    return null;
  }

  const rawValue = storage.getItem(PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY);
  if (!rawValue) {
    return null;
  }
  storage.removeItem(PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY);

  try {
    const parsed = JSON.parse(rawValue) as Partial<PendingFirstEncounterTaskLaunch>;
    return typeof parsed.prompt === "string" && parsed.prompt.trim() ? parsed.prompt.trim() : null;
  } catch {
    return rawValue.trim() || null;
  }
}
