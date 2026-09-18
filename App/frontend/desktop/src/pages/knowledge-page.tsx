import { useAppState } from "../state/app-state.js";
import { appActions } from "../state/app-actions.js";
import { KnowledgePage as KnowledgeManagement } from "@memmy/knowledge/ui";
import { useApiClients } from "../app/providers.js";
import { useTranslation } from "../i18n/use-translation.js";
import { AppFrame } from "./app-frame.js";

export function KnowledgePage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { language, t } = useTranslation();
  return (
    <AppFrame title={t("nav.knowledge")}>
      <div className="h-full overflow-y-auto">
        {clients && (
          <KnowledgeManagement
            key={state.account.userId ?? "signed-out"}
            onSignIn={() => dispatch(appActions.navigate("/login"))}
            connection={clients.runtimeConfig}
            language={language}
          />
        )}
      </div>
    </AppFrame>
  );
}
