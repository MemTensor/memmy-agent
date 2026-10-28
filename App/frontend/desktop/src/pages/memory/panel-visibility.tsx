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
