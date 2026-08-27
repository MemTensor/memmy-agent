import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTemplate, renderTemplate } from "../../src/utils/prompt-templates.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-prompt-template-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("prompt templates", () => {
  it("throws when a template is missing", () => {
    expect(() => loadTemplate("agent/does-not-exist.md")).toThrow(/Template not found/);
    expect(() => renderTemplate("agent/does-not-exist.md")).toThrow(/Template not found/);
  });

  it("renders Jinja-compatible loops for absolute templates", () => {
    const file = path.join(tempRoot(), "loop.md");
    fs.writeFileSync(
      file,
      "{% for item in items %}{{ loop.index }}:{{ item }};{% endfor %}",
      "utf8",
    );

    expect(renderTemplate(file, { items: ["a", "b"] })).toBe("1:a;2:b;");
  });

  it("renders bundled includes and raw blocks", () => {
    const text = renderTemplate("agent/identity.md", {
      runtime: "runtime",
      workspacePath: "/workspace",
      platformPolicy: "policy",
      channel: "telegram",
    });

    expect(text).toContain("/workspace/skills/{skill-name}/SKILL.md");
    expect(text).toContain("untrusted external data");
    expect(text).toContain("Format Hint");
  });
});
