/** Lightweight GitHub star prompt card. */
import { useTranslation } from "../i18n/use-translation.js";

export interface GithubStarPromptProps {
  onStar: () => void;
  onDismiss: () => void;
}

/** Bottom-right soft card prompting users to star the GitHub repo. */
export function GithubStarPrompt(props: GithubStarPromptProps) {
  const { t } = useTranslation();

  return (
    <aside className="github-star-prompt" role="dialog" aria-label={t("githubStar.title")}>
      <div className="github-star-prompt__card animate-fade-up">
        <p className="github-star-prompt__title">{t("githubStar.title")}</p>

        <p className="github-star-prompt__body">
          <span>{t("githubStar.bodyLine1")}</span>
          <span>{t("githubStar.bodyLine2")}</span>
        </p>

        <div className="github-star-prompt__actions">
          <button type="button" className="github-star-prompt__primary" onClick={props.onStar}>
            {t("githubStar.cta")}
          </button>
          <button type="button" className="github-star-prompt__secondary" onClick={props.onDismiss}>
            {t("githubStar.later")}
          </button>
        </div>
      </div>
    </aside>
  );
}
