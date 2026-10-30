import { BarChart3, BookOpen, FileCheck2, FileText, FolderOpen, ListChecks, ListTree, Presentation, Quote, Scale, Sparkles } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import "./plugin-detail-preview.css";

export interface PluginDetailPreviewProps {
  category: "legal" | "research" | "office" | "other";
  name: string;
}

const previewExamples = {
  research: {
    icon: BookOpen,
    prompts: [
      { icon: FileText, key: "plugins.examples.generateALiteratureReviewOnAIMemory" },
      { icon: ListTree, key: "plugins.examples.outlineALiteratureReviewFromThesePapers" },
      { icon: Quote, key: "plugins.examples.markPassagesInMyDraftThatNeedCitations" }
    ]
  },
  office: {
    icon: Presentation,
    prompts: [
      { icon: FileText, key: "plugins.examples.turnTheseMeetingNotesIntoAWordDocument" },
      { icon: BarChart3, key: "plugins.examples.createChartsAndASummaryFromThisSpreadsheet" },
      { icon: Presentation, key: "plugins.examples.turnThisProjectPlanIntoADraftSlide" }
    ]
  },
  legal: {
    icon: Scale,
    prompts: [
      { icon: FolderOpen, key: "plugins.examples.organizeTheseEmploymentResearchMaterials" },
      { icon: ListChecks, key: "plugins.examples.draftInterviewQuestionsToVerifyTheInformation" },
      { icon: FileCheck2, key: "plugins.examples.prepareAReportDraftForALawyerTo" }
    ]
  },
  other: {
    icon: Sparkles,
    prompts: [
      { icon: FileText, key: "plugins.examples.organizeThisMaterialAndListItsKeyPoints" },
      { icon: ListChecks, key: "plugins.examples.outlineTheNextStepsTowardThisGoal" },
      { icon: Sparkles, key: "plugins.examples.prepareAnEditableFirstDraftFromMyInstructions" }
    ]
  }
} as const;

/** A static introduction visual. Examples do not submit prompts or start tasks. */
export function PluginDetailPreview(props: PluginDetailPreviewProps) {
  const { t } = useTranslation();
  const config = previewExamples[props.category];
  const AmbientIcon = config.icon;

  return (
    <figure className={`plugin-detail-preview plugin-detail-preview--${props.category}`}
      aria-label={t("plugins.examples.usageExamples")}>
      <figcaption className="plugin-detail-preview-caption">
        {t("plugins.examples.examplesOfUsing", { name: props.name })}
      </figcaption>
      <div className="plugin-detail-preview-ambient" aria-hidden="true">
        <span className="plugin-detail-preview-orbit" />
        <AmbientIcon className="plugin-detail-preview-ambient-icon" strokeWidth={1.2} />
        <Sparkles className="plugin-detail-preview-sparkles" strokeWidth={1.3} />
      </div>
      <ul className="plugin-detail-preview-examples">
        {config.prompts.map((prompt) => {
          const Icon = prompt.icon;
          return (
            <li key={prompt.key} className="plugin-detail-preview-example">
              <Icon className="plugin-detail-preview-example-icon" strokeWidth={1.6} aria-hidden="true" />
              <span className="plugin-detail-preview-example-text">{t(prompt.key)}</span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
