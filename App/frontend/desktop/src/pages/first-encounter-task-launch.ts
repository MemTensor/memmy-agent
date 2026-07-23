export const PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY = "memmy.pendingFirstEncounterTaskLaunch";
export const FIRST_ENCOUNTER_RELAY_CHAT_KEY = "memmy.firstEncounterRelayChat";
export const FIRST_ENCOUNTER_RELAY_ARMED_KEY = "memmy.firstEncounterRelayArmed";
export const FIRST_ENCOUNTER_RELAY_READY_CHAT_KEY = "memmy.firstEncounterRelayReadyChat";

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

export function writeFirstEncounterRelayChat(storage: StorageLike | null | undefined, chatId: string): void {
  const normalizedChatId = chatId.trim();
  if (!storage || !normalizedChatId) {
    return;
  }
  storage.setItem(FIRST_ENCOUNTER_RELAY_CHAT_KEY, normalizedChatId);
}

export function readFirstEncounterRelayChat(storage: StorageLike | null | undefined): string | null {
  return storage?.getItem(FIRST_ENCOUNTER_RELAY_CHAT_KEY)?.trim() || null;
}

export function writeFirstEncounterRelayReadyChat(storage: StorageLike | null | undefined, chatId: string): void {
  const normalizedChatId = chatId.trim();
  if (!storage || !normalizedChatId) {
    return;
  }
  storage.setItem(FIRST_ENCOUNTER_RELAY_READY_CHAT_KEY, normalizedChatId);
}

export function readFirstEncounterRelayReadyChat(storage: StorageLike | null | undefined): string | null {
  return storage?.getItem(FIRST_ENCOUNTER_RELAY_READY_CHAT_KEY)?.trim() || null;
}

/** Arms the next first-created chat for the post-answer relay card. */
export function armFirstEncounterRelayChat(storage: StorageLike | null | undefined): void {
  storage?.setItem(FIRST_ENCOUNTER_RELAY_ARMED_KEY, "1");
}

/** Consumes the one-shot relay arm after the first chat has been created. */
export function consumeFirstEncounterRelayArm(storage: StorageLike | null | undefined): boolean {
  if (storage?.getItem(FIRST_ENCOUNTER_RELAY_ARMED_KEY) !== "1") {
    return false;
  }
  storage.removeItem(FIRST_ENCOUNTER_RELAY_ARMED_KEY);
  return true;
}
