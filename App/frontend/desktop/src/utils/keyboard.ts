import type { KeyboardEvent } from "react";

export function isComposingKeyboardEvent(event: KeyboardEvent<Element>): boolean {
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & { keyCode?: number };
  return Boolean(nativeEvent.isComposing || (event as { isComposing?: boolean }).isComposing || nativeEvent.keyCode === 229);
}
