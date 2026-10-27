import { createContext, useContext, useSyncExternalStore } from "react";
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
