import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / governance / markdown audit", () => {
  it("exports editable front matter and applies a scoped body/title edit", () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "main",
      userId: "markdown-user",
      workspacePath: "/work/markdown-project"
    };
    const added = service.addMemory({
      namespace,
      layer: "L2",
      title: "Original title",
      tags: ["audit"],
      content: "Original body for the audit file."
    });
    const exported = service.exportMarkdown({ namespace });
    expect(exported.count).toBe(1);
    expect(exported.markdown).toContain(`id: ${added.id}`);
    expect(exported.markdown).toContain("editable:");
    expect(exported.markdown).toContain("Original body for the audit file.");

    const edited = exported.markdown
      .replace("Original title", "Reviewed title")
      .replace("Original body for the audit file.", "Reviewed body after human audit.");
    const preview = service.importMarkdown({ namespace, markdown: edited, apply: false });
    expect(preview.updated).toEqual([added.id]);
    expect(service.getMemory(added.id, { namespace })).toMatchObject({ id: added.id });

    const applied = service.importMarkdown({ namespace, markdown: edited, apply: true });
    expect(applied.updated).toEqual([added.id]);
    const detail = service.getMemory(added.id, { namespace }) as { title: string; body: string };
    expect(detail.title).toBe("Reviewed title");
    expect(detail.body).toBe("Reviewed body after human audit.");
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'markdown_update'").get()).toMatchObject({ count: 1 });
    db.close();
  });

  it("rejects a markdown document from another project", () => {
    const { db, service } = createTestService();
    const a = { source: "codex", profileId: "main", userId: "markdown-user", workspacePath: "/work/markdown-a" };
    const b = { source: "codex", profileId: "main", userId: "markdown-user", workspacePath: "/work/markdown-b" };
    service.addMemory({ namespace: a, layer: "L2", title: "Scoped", content: "Only project A." });
    const exported = service.exportMarkdown({ namespace: a });
    const result = service.importMarkdown({ namespace: b, markdown: exported.markdown, apply: true });
    expect(result.updated).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toMatch(/memory not found/);
    db.close();
  });
});
