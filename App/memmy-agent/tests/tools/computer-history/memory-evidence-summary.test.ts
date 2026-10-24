import { describe, expect, it } from "vitest";
import { historyEvidenceSummary } from "../../../src/tools/computer-history/memory-evidence-summary.js";

describe("History evidence summary", () => {
  it("keeps the narrated description separate from a Markdown title", () => {
    expect(historyEvidenceSummary("# Release note\n\n## Memory summary\n\nReviewed the draft.",
      "You reviewed the draft and recorded the outstanding changes.")).toBe(
      "You reviewed the draft and recorded the outstanding changes.");
  });

  it("recovers the actual memory-summary section in older summaries", () => {
    expect(historyEvidenceSummary("# Release note\r\n\r\n## Memory summary\r\n\r\nReviewed the draft.\r\n\r\nSecond paragraph.\r\n\r\n### Relevant prior context\r\n\r\nEarlier work.\r\n\r\n## Recording summary\r\n\r\nOpened the editor.", "null"))
      .toBe("Reviewed the draft.\n\nSecond paragraph.");
  });

  it("decodes the writer's quoted frontmatter without leaking JSON escapes into the summary", () => {
    expect(historyEvidenceSummary('---\ndescription: "You reviewed the \\"ready\\" draft."\n---\n\n# Release note',
      'You reviewed the \\"ready\\" draft.')).toBe('You reviewed the "ready" draft.');
  });

  it("does not fabricate a summary from a title-only entry", () => {
    expect(historyEvidenceSummary("# Release note\n\n## Recording summary\n\nOpened the editor.")).toBeUndefined();
  });
});
