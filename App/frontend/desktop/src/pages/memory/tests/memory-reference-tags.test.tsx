import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MemoryReferenceTags, resolveMemoryReferencePage } from "../memory-reference-tags.js";

describe("memory reference tags", () => {
  it.each([
    ["episode_1", "tasks"],
    ["codex::trace_1", "memories"],
    ["memory-policy-1", "policies"],
    ["world_model_1", "world-model"],
    ["skill_1", "skills"]
  ] as const)("routes %s to %s", (id, page) => {
    expect(resolveMemoryReferencePage(id, "memories")).toBe(page);
  });

  it("uses the field meaning for an unrecognized legacy id", () => {
    expect(resolveMemoryReferencePage("legacy_1", "policies")).toBe("policies");
  });

  it("renders a clickable tag and keeps the complete id in its title", () => {
    const html = renderToString(
      <MemoryReferenceTags
        ids={["codex::memory-policy-12345678901234567890"]}
        fallbackPage="policies"
        onOpen={vi.fn()}
      />
    );

    expect(html).toContain("<button");
    expect(html).toContain("memory-policy-id--link");
    expect(html).toContain('title="codex::memory-policy-12345678901234567890"');
    expect(html).toContain("memory-policy-1234...");
  });
});
