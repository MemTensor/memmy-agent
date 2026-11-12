import { createContext, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
export const PanelVisibilityContext = createContext(true);
const subscribe = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
const isForeground = () => !document.hidden;
export function usePanelVisible() {
  const active = useContext(PanelVisibilityContext);
  const foreground = useSyncExternalStore(subscribe, isForeground, () => true);
  return active && foreground;
}

/** Late mutation callbacks must check current visibility and client ownership. */
export function usePanelReadGuard(client: unknown) {
  const visible = usePanelVisible();
  const current = useRef({ client, visible });
  useLayoutEffect(() => {
    current.current = { client, visible };
    return () => { current.current.visible = false; };
  }, [client, visible]);
  return () => current.current.client === client && current.current.visible && !document.hidden;
}

/** A page owns its subscription and resumes only its still-selected read. */
export function usePanelVisibilityLifecycle(owner: unknown, suspend: () => void, resume: () => void) {
  const visible = usePanelVisible();
  const previous = useRef({visible, owner});
  const callbacks = useRef({ suspend, resume });
  callbacks.current = { suspend, resume };
  useLayoutEffect(() => {
    if (!visible || previous.current.owner !== owner) callbacks.current.suspend();
    else if (!previous.current.visible) callbacks.current.resume();
    previous.current = {visible, owner};
  }, [visible, owner]);
}
