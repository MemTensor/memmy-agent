export const PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY = "memmy.pendingFirstEncounterTaskLaunch";
export const FIRST_ENCOUNTER_RELAY_CHAT_KEY = "memmy.firstEncounterRelayChat";
export const FIRST_ENCOUNTER_RELAY_ARMED_KEY = "memmy.firstEncounterRelayArmed";
export const FIRST_ENCOUNTER_RELAY_READY_CHAT_KEY = "memmy.firstEncounterRelayReadyChat";
export const FIRST_ENCOUNTER_RELAY_PROMPT_KEY = "memmy.firstEncounterRelayPrompt";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingFirstEncounterTaskLaunch {
  prompt: string;
  /** When set, Home seeds this assistant reply into the chat instead of re-running the agent. */
  assistantContent?: string;
  /** When set, Home opens this already-seeded chat instead of calling seed-chat again. */
  chatId?: string;
  sessionKey?: string;
  createdAt: number;
}

export interface WritePendingFirstEncounterTaskLaunchOptions {
  assistantContent?: string;
  chatId?: string;
  sessionKey?: string;
  now?: number;
}

export function writePendingFirstEncounterTaskLaunch(
  storage: StorageLike | null | undefined,
  prompt: string,
  options: WritePendingFirstEncounterTaskLaunchOptions = {}
): void {
  const trimmedPrompt = prompt.trim();
  if (!storage || !trimmedPrompt) {
    return;
  }

  const assistantContent = options.assistantContent?.trim();
  const chatId = options.chatId?.trim();
  const sessionKey = options.sessionKey?.trim();
  storage.setItem(PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY, JSON.stringify({
    prompt: trimmedPrompt,
    ...(assistantContent ? { assistantContent } : {}),
    ...(chatId ? { chatId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    createdAt: options.now ?? Date.now()
  } satisfies PendingFirstEncounterTaskLaunch));
}

/** Clears a pending report task so entering a blank conversation cannot auto-send stale content. */
export function clearPendingFirstEncounterTaskLaunch(storage: StorageLike | null | undefined): void {
  storage?.removeItem(PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY);
}

export function consumePendingFirstEncounterTaskLaunch(
  storage: StorageLike | null | undefined
): PendingFirstEncounterTaskLaunch | null {
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
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
    if (!prompt) {
      return null;
    }
    const assistantContent = typeof parsed.assistantContent === "string" ? parsed.assistantContent.trim() : "";
    const chatId = typeof parsed.chatId === "string" ? parsed.chatId.trim() : "";
    const sessionKey = typeof parsed.sessionKey === "string" ? parsed.sessionKey.trim() : "";
    return {
      prompt,
      ...(assistantContent ? { assistantContent } : {}),
      ...(chatId ? { chatId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now()
    };
  } catch {
    const prompt = rawValue.trim();
    return prompt ? { prompt, createdAt: Date.now() } : null;
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

export function writeFirstEncounterRelayPrompt(storage: StorageLike | null | undefined, prompt: string): void {
  const normalizedPrompt = prompt.trim();
  if (!storage || !normalizedPrompt) {
    return;
  }
  storage.setItem(FIRST_ENCOUNTER_RELAY_PROMPT_KEY, normalizedPrompt);
}

export function readFirstEncounterRelayPrompt(storage: StorageLike | null | undefined): string | null {
  return storage?.getItem(FIRST_ENCOUNTER_RELAY_PROMPT_KEY)?.trim() || null;
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
