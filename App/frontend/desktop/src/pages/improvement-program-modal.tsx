import { ExternalLink, Gift } from "lucide-react";
import { Memmy } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";

export interface ImprovementProgramModalProps {
  onChoice: (accepted: boolean) => void;
  onLearnMore: () => void;
  showGift?: boolean;
}

export function ImprovementProgramModal(props: ImprovementProgramModalProps) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-text-ink/30 backdrop-blur-sm">
      <div className="bg-background-paper rounded-card-lg shadow-2xl w-full max-w-md mx-4 overflow-hidden border border-border-stone/30">
        <div className="px-7 pt-7 pb-4 text-center">
          <div className="flex justify-center mb-1">
            <Memmy pose="hum" size={120} className="memmy-bob" />
          </div>
          <h2 className="text-lg font-bold text-text-ink">{t("onboarding.improvement.title")}</h2>
          <p className="text-sm text-text-ink/65 mt-1.5 leading-relaxed">{t("onboarding.improvement.body")}</p>
        </div>

        <div className="px-7">
          {(props.showGift ?? true) && (
            <div className="bg-action-sky/10 border border-action-sky/25 rounded-card p-4 mb-4">
              <div className="flex items-center gap-2.5">
                <Gift size={16} className="text-action-sky" />
                <span className="text-sm text-text-ink/70">
                  {t("onboarding.improvement.benefitPrefix")}{" "}
                  <strong className="text-action-sky">{t("onboarding.improvement.benefitToken")}</strong>
                </span>
              </div>
            </div>
          )}

          <div className="flex items-center justify-center gap-3 text-[11px] text-text-ink/50">
            <span>{t("onboarding.improvement.note")}</span>
            <button
              type="button"
              onClick={props.onLearnMore}
              className="inline-flex items-center gap-1 text-action-sky/70 hover:text-action-sky transition-colors cursor-pointer"
            >
              {t("onboarding.improvement.learnMore")}
              <ExternalLink size={10} />
            </button>
          </div>
        </div>

        <div className="flex gap-3 px-7 py-6 mt-1">
          <button
            type="button"
            onClick={() => props.onChoice(false)}
            className="flex-1 py-3 text-sm text-text-ink/65 bg-canvas-oat border border-border-stone/40 rounded-btn hover:bg-canvas-oat/80 transition-colors cursor-pointer"
          >
            {t("onboarding.improvement.skip")}
          </button>
          <button
            type="button"
            onClick={() => props.onChoice(true)}
            className="flex-1 py-3 text-sm text-white bg-action-sky rounded-btn hover:bg-action-sky-hover transition-colors font-semibold cursor-pointer shadow-md"
          >
            {t("onboarding.improvement.accept")}
          </button>
        </div>
      </div>
    </div>
  );
}
