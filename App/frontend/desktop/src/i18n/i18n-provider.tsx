/** I18n provider module. */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Language } from "@memmy/local-api-contracts";
import {
  formatMessage,
  messageCatalogs,
  resolveLanguage,
  type MessageKey,
  type MessageValues,
  type ResolvedLanguage
} from "./messages.js";

export interface I18nContextValue {
  language: ResolvedLanguage;
  t(key: MessageKey, values?: MessageValues): string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider(props: { language: Language | string | undefined; children: ReactNode }) {
  const language = resolveLanguage(props.language);
  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      t(key, values) {
        return formatMessage(messageCatalogs[language][key], values);
      }
    }),
    [language]
  );

  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);

  if (!value) {
    throw new Error("useI18n must be used within I18nProvider");
  }

  return value;
}
