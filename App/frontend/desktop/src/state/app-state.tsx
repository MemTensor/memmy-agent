/** App state module. */
import { createContext, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from "react";
import type { AppAction } from "./app-actions.js";
import { appReducer, createInitialAppState, type AppState } from "./app-reducer.js";

/** Contract for app state context value. */
export interface AppStateContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

/** Handles app state provider. */
export function AppStateProvider(props: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, undefined, createInitialAppState);
  const value = useMemo(() => ({ state, dispatch }), [state]);

  return <AppStateContext.Provider value={value}>{props.children}</AppStateContext.Provider>;
}

/** Handles use app state. */
export function useAppState(): AppStateContextValue {
  const value = useContext(AppStateContext);

  if (!value) {
    throw new Error("useAppState must be used within AppStateProvider");
  }

  return value;
}
