import type { SkillManifest } from "../types.js";

export const MEMMY_SKILL_DIRECTORY_NAME = "memmy-memory";
export const MEMMY_RESUME_SKILL_DIRECTORY_NAME = "memmy-resume";

export interface RenderedSkillDirectoryFile {
  relativePath: string;
  content: string;
}

export function renderMemmySkillDirectoryFiles(manifest: SkillManifest): RenderedSkillDirectoryFile[] {
  return [
    {
      relativePath: "SKILL.md",
      content: [
        "---",
        "name: memmy-memory",
        "description: Use shared Memmy memory when prior context may be relevant.",
        "---",
        "",
        manifest.content.trimEnd(),
        ""
      ].join("\n")
    }
  ];
}

export function renderMemmySkillBootstrapManifest(manifest: SkillManifest): SkillManifest {
  return {
    ...manifest,
    content: [
      "# Memmy Memory",
      "",
      "The `memmy-memory` skill is installed at `skills/memmy-memory/SKILL.md`.",
      "Use that skill when prior memory may be relevant to the current request."
    ].join("\n")
  };
}

export function renderMemmyResumeSkillFile(source: string): string {
  return [
    "---",
    "name: memmy-resume",
    "description: Search Memmy L1 episodes and continue a selected prior task. Use when the user explicitly invokes /memmy-resume.",
    "disable-model-invocation: true",
    "---",
    "",
    "# Memmy Resume",
    "",
    "Resume a prior task from shared Memmy memory.",
    "",
    "A host hook or native command may handle `/memmy-resume <query>` and `/memmy-resume <1-5>` before this skill reaches the model.",
    "",
    "## Fallback",
    "",
    "If this skill reaches the model, preserve the same user-facing workflow:",
    "",
    `1. For a text query, run \`memmy-memory search "<query>" --source ${source}\`, keep at most five L1 episode candidates, and show their ids and summaries as a numbered list.`,
    `2. For a selection from \`1\` to \`5\`, use the matching episode id from the latest candidate list, run \`memmy-memory get "<episode_id>" --source ${source}\`, and continue the selected task from that context.`,
    "3. For `cancel`, discard the latest candidate list.",
    "4. Never invent an episode or ask the user to paste an episode that Memmy can retrieve.",
    ""
  ].join("\n");
}
