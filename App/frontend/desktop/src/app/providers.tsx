/** Providers module. */
import { createContext, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { AppClients } from "../api/client-types.js";
import { I18nProvider } from "../i18n/i18n-provider.js";
import { TaskBusProvider } from "../lib/task-bus.js";
import { AppStateProvider, useAppState } from "../state/app-state.js";
import { ThemeProvider } from "../theme/theme-provider.js";
import { useWindowFullScreenSync } from "../utils/window-fullscreen.js";
import { resolveDesktopDisplayLanguage } from "./account-channel.js";

/** Contract for api clients context value. */
export interface ApiClientsContextValue {
  clients: AppClients | null;
  setClients: Dispatch<SetStateAction<AppClients | null>>;
}

const ApiClientsContext = createContext<ApiClientsContextValue | null>(null);

/** Handles app providers. */
export function AppProviders(props: { children: ReactNode }) {
  return (
    <AppStateProvider>
      <ApiClientsProvider>
        <TaskBusProvider>
          <VisualProviders>{props.children}</VisualProviders>
        </TaskBusProvider>
      </ApiClientsProvider>
    </AppStateProvider>
  );
}

/** Handles api clients provider. */
function ApiClientsProvider(props: { children: ReactNode }) {
  const [clients, setClients] = useState<AppClients | null>(null);
  const value = useMemo(() => ({ clients, setClients }), [clients]);

  return <ApiClientsContext.Provider value={value}>{props.children}</ApiClientsContext.Provider>;
}

/** Handles visual providers. */
function VisualProviders(props: { children: ReactNode }) {
  const { state } = useAppState();
  const language = resolveDesktopDisplayLanguage(state.bootstrap?.app.language);
  const theme = state.bootstrap?.app.theme ?? "system";
  useWindowFullScreenSync();

  return (
    <I18nProvider language={language}>
      <ThemeProvider theme={theme}>{props.children}</ThemeProvider>
    </I18nProvider>
  );
}

/** Handles use api clients. */
export function useApiClients(): ApiClientsContextValue {
  const value = useContext(ApiClientsContext);

  if (!value) {
    throw new Error("useApiClients must be used within AppProviders");
  }

  return value;
}

/** Handles use optional api clients. */
export function useOptionalApiClients(): ApiClientsContextValue {
  return useContext(ApiClientsContext) ?? { clients: null, setClients: () => undefined };
}
