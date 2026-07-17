/** Theme provider module. */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { Theme } from "@memmy/local-api-contracts";

/** Type definition for resolved theme. */
export type ResolvedTheme = "light";

/** Contract for theme context value. */
export interface ThemeContextValue {
  theme: Theme | string | undefined;
  resolvedTheme: ResolvedTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Handles resolve theme preference. */
export function resolveThemePreference(_theme: Theme | string | undefined, _systemPrefersDark?: boolean): ResolvedTheme {
  return "light";
}

/** Handles theme provider. */
export function ThemeProvider(props: { theme: Theme | string | undefined; children: ReactNode }) {
  const resolvedTheme = resolveThemePreference(props.theme);
  const value = useMemo(() => ({ theme: props.theme, resolvedTheme }), [props.theme, resolvedTheme]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

/** Handles use theme context. */
export function useThemeContext(): ThemeContextValue {
  const value = useContext(ThemeContext);

  if (!value) {
    throw new Error("useThemeContext must be used within ThemeProvider");
  }

  return value;
}
