import type { MemoryTokenBudgetDto } from "@memmy/local-api-contracts";
import { Banner } from "./banner.js";
import { useTranslation } from "../i18n/use-translation.js";

export interface MemoryTokenBudgetBannerProps {
  budget: MemoryTokenBudgetDto;
  onOpenSettings: () => void;
}

export function MemoryTokenBudgetBanner(props: MemoryTokenBudgetBannerProps) {
  const { t } = useTranslation();
  if (!props.budget.paused) {
    return null;
  }

  return (
    <button
      type="button"
      className="memory-token-budget-banner"
      onClick={props.onOpenSettings}
    >
      <Banner tone="danger">
        {t(props.budget.trigger === "daily"
          ? "memory.tokenBudget.bannerDaily"
          : "memory.tokenBudget.bannerTotal")}
      </Banner>
    </button>
  );
}
