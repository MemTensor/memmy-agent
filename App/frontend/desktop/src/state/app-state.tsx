/** App state module. */
import { createContext, useContext, useEffect, useMemo, useReducer, type Dispatch, type ReactNode } from "react";
import { appActions, type AppAction } from "./app-actions.js";
import { appReducer, createInitialAppState, type AppState } from "./app-reducer.js";

/** Contract for app state context value. */
export interface AppStateContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

/** Handles app state provider. */
export function AppStateProvider(props: { children: ReactNode }) {
  // Desktop-pet mode hides the native main window while keeping its current route.
  const [state, dispatch] = useReducer(appReducer, undefined, () => createInitialAppState(
    typeof document === "undefined" || document.visibilityState !== "hidden"
  ));
  const value = useMemo(() => ({ state, dispatch }), [state]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const syncWindowVisibility = () => {
      dispatch(appActions.windowVisibilityChanged(document.visibilityState !== "hidden"));
    };
    document.addEventListener("visibilitychange", syncWindowVisibility);
    syncWindowVisibility();
    return () => document.removeEventListener("visibilitychange", syncWindowVisibility);
  }, []);

  return <AppStateContext.Provider value={value}>{props.children}</AppStateContext.Provider>;
}

/** The app state, or null where it is not provided — a page rendered on its own in tests. */
export function useOptionalAppState(): AppStateContextValue | null {
  return useContext(AppStateContext);
}

/** Handles use app state. */
export function useAppState(): AppStateContextValue {
  const value = useContext(AppStateContext);

  if (!value) {
    throw new Error("useAppState must be used within AppStateProvider");
  }

  return value;
}
