import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Dream, MemoryStore } from "../../../src/core/agent-runtime/memory.js";

describe("Dream tool registry", () => {
  it("allows Dream to read/edit workspace files and create skills only inside skills", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-dream-tools-"));
    const dream = new Dream({ store: new MemoryStore(root), provider: {}, model: "m" });

    const tools = dream.buildTools();
    expect(tools.toolNames).toEqual(expect.arrayContaining(["read_file", "edit_file", "write_file"]));
    expect(tools.get("edit_file")).toMatchObject({ postWriteValidation: false });
    expect(tools.get("write_file")).toMatchObject({ postWriteValidation: false });
    expect(fs.existsSync(path.join(root, "skills"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
