/**
 * History is now a contextual, one-time introduction. It has no fixed sunset:
 * users who do not visit Memory can still discover it later.
 */
export const HISTORY_LAUNCH_PROMPT_EXPIRES_AT: string | null = null;
export const HISTORY_LAUNCH_PROMPT_STORAGE_KEY = "memmy.historyLaunchPrompt.v1";
export const HISTORY_LAUNCH_VISIBILITY_EVENT = "memmy:history-launch-prompt-visibility";
const HISTORY_LAUNCH_NAVIGATION_SESSION_KEY = "memmy.historyLaunchPrompt.navigating";

interface HistoryLaunchPromptState {
  shown: boolean;
  dismissed: boolean;
  actioned: boolean;
}

const EMPTY_STATE: HistoryLaunchPromptState = { shown: false, dismissed: false, actioned: false };
let promptOpen = false;

export function isHistoryLaunchPromptOpen(): boolean {
  return promptOpen;
}

export function setHistoryLaunchPromptOpen(open: boolean): void {
  if (promptOpen === open) return;
  promptOpen = open;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(HISTORY_LAUNCH_VISIBILITY_EVENT));
}

export function readHistoryLaunchPromptState(storage: Storage | undefined): HistoryLaunchPromptState {
  try {
    const raw = storage?.getItem(HISTORY_LAUNCH_PROMPT_STORAGE_KEY);
    if (!raw) return { ...EMPTY_STATE };
    const parsed = JSON.parse(raw) as Partial<HistoryLaunchPromptState>;
    return {
      shown: parsed.shown === true,
      dismissed: parsed.dismissed === true,
      actioned: parsed.actioned === true,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function update(storage: Storage | undefined, patch: Partial<HistoryLaunchPromptState>): void {
  if (!storage) return;
  storage.setItem(HISTORY_LAUNCH_PROMPT_STORAGE_KEY, JSON.stringify({
    ...readHistoryLaunchPromptState(storage), ...patch,
  }));
}

export function isHistoryLaunchPromptWithinWindow(nowMs: number = Date.now()): boolean {
  return HISTORY_LAUNCH_PROMPT_EXPIRES_AT === null
    || nowMs < Date.parse(HISTORY_LAUNCH_PROMPT_EXPIRES_AT);
}

export function shouldOfferHistoryLaunchPrompt(input: {
  state: HistoryLaunchPromptState;
  supported: boolean;
  nowMs?: number;
}): boolean {
  return input.supported
    && isHistoryLaunchPromptWithinWindow(input.nowMs ?? Date.now())
    && !input.state.shown
    && !input.state.dismissed
    && !input.state.actioned;
}

export function markHistoryLaunchPromptShown(storage: Storage | undefined): void {
  update(storage, { shown: true });
}

export function markHistoryLaunchPromptDismissed(storage: Storage | undefined): void {
  update(storage, { shown: true, dismissed: true });
}

export function markHistoryLaunchPromptActioned(storage: Storage | undefined): void {
  update(storage, { shown: true, actioned: true });
}

/** Keep other one-shot prompts out of History's consent flow for this session. */
export function deferOtherPromptsForHistoryLaunch(storage: Storage | undefined): void {
  storage?.setItem(HISTORY_LAUNCH_NAVIGATION_SESSION_KEY, "1");
}

export function areOtherPromptsDeferredForHistoryLaunch(storage: Storage | undefined): boolean {
  return storage?.getItem(HISTORY_LAUNCH_NAVIGATION_SESSION_KEY) === "1";
}
