import { matchesGeneratedLanguage } from "./generated-language.js";
import { clip } from "../utils/text.js";

/** Pick human-readable text before rendering the guide and its list/detail projections. */
export function generatedSkillTitle(language: string, identifiers: unknown[], ...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const title = clip(candidate, 100);
    if (title && !identifiers.includes(title) && !/^[a-z\d]+(?:[_-][a-z\d]+)+$/i.test(title)
      && matchesGeneratedLanguage(title, language)) return title;
  }
  throw new Error(`generated Skill needs a display title in ${language}`);
}

const chineseLabels = {
  "When to use": ["适用场景", "適用場景"],
  Procedure: ["操作步骤", "操作步驟"],
  Parameters: ["参数", "參數"],
  Preconditions: ["前提条件", "前提條件"],
  Examples: ["示例", "範例"],
  "Tools used": ["使用工具", "使用工具"],
  "Decision guidance": ["决策建议", "決策建議"],
  Prefer: ["建议", "建議"], Avoid: ["避免", "避免"],
  Input: ["输入", "輸入"], Expected: ["预期结果", "預期結果"],
  required: ["必填", "必填"],
  "(from successful RawTurns)": ["（来自成功的任务记录）", "（來自成功的任務記錄）"],
  "(derived from policy)": ["（来自经验策略）", "（來自經驗策略）"]
} as const;

export function skillGuideLabel(label: keyof typeof chineseLabels, language?: string): string {
  if (!language || !/^zh(?:-|$)/i.test(language)) return label;
  return chineseLabels[label][new Intl.Locale(language).maximize().script === "Hant" ? 1 : 0];
}

export function skillGuideSectionKey(label: string): string {
  for (const [key, translations] of Object.entries(chineseLabels)) {
    if (translations.some(text => label === text)) return key.toLowerCase();
  }
  return label.toLowerCase();
}
