/** Definition for token exhausted apply more storage key. */

const TOKEN_EXHAUSTED_APPLY_MORE_STORAGE_KEY = "memmy.tokenExhaustedApplyMoreRequest";
export const TOKEN_EXHAUSTED_APPLY_MORE_EVENT = "memmy:token-exhausted-apply-more";

interface ApplyMoreStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

interface ApplyMoreEventTargetLike {
  dispatchEvent: (event: Event) => boolean;
}

export function writeTokenExhaustedApplyMoreRequest(storage: ApplyMoreStorageLike | undefined): void {
  storage?.setItem(TOKEN_EXHAUSTED_APPLY_MORE_STORAGE_KEY, "1");
}

export function consumeTokenExhaustedApplyMoreRequest(storage: ApplyMoreStorageLike | undefined): boolean {
  if (storage?.getItem(TOKEN_EXHAUSTED_APPLY_MORE_STORAGE_KEY) !== "1") {
    return false;
  }

  if (storage.removeItem) {
    storage.removeItem(TOKEN_EXHAUSTED_APPLY_MORE_STORAGE_KEY);
  } else {
    storage.setItem(TOKEN_EXHAUSTED_APPLY_MORE_STORAGE_KEY, "");
  }
  return true;
}

export function emitTokenExhaustedApplyMoreRequest(target: ApplyMoreEventTargetLike | undefined): void {
  target?.dispatchEvent(new Event(TOKEN_EXHAUSTED_APPLY_MORE_EVENT));
}
