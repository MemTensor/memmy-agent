import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  IncrementalThinkExtractor,
  buildAssistantMessage,
  buildImageContentBlocks,
  estimateMessageTokens,
  estimatePromptTokens,
  estimatePromptTokensChain,
  findLegalMessageStart,
  maybePersistToolResult,
  safeFilename,
  stringifyTextBlocks,
  syncWorkspaceTemplates,
} from "../../src/utils/helpers.js";

class NoCounterProvider {}

class BrokenCounterProvider {
  estimatePromptTokens(): never {
    throw new Error("counter unavailable");
  }
}

describe("estimatePromptTokensChain", () => {
  it("falls back without a provider counter", () => {
    const [tokens, source] = estimatePromptTokensChain(new NoCounterProvider(), "test-model", [{ role: "user", content: "hello" }]) as [number, string];
    expect(tokens).toBeGreaterThan(0);
    expect(source).toBe("tiktoken");
  });

  it("falls back when a provider counter fails", () => {
    const [tokens, source] = estimatePromptTokensChain(new BrokenCounterProvider(), "test-model", [{ role: "user", content: "hello" }]) as [number, string];
    expect(tokens).toBeGreaterThan(0);
    expect(source).toBe("tiktoken");
  });

  it("counts message fields and tool schemas", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
      name: "assistant-name",
      tool_calls: [{ id: "call-1", function: { name: "search", arguments: "{}" } }],
      reasoning_content: "private steps",
    };

    expect(estimateMessageTokens(message)).toBeGreaterThan(4);
    expect(estimatePromptTokens([message], [{ name: "search", parameters: {} }])).toBeGreaterThan(estimatePromptTokens([message]));
  });

  it("builds assistant messages and native image content blocks", () => {
    expect(buildAssistantMessage("answer", [{ id: "call-1" }], "reason", [{ type: "thinking", thinking: "t" }])).toMatchObject({
      role: "assistant",
      content: "answer",
      tool_calls: [{ id: "call-1" }],
      reasoning_content: "reason",
      thinking_blocks: [{ type: "thinking", thinking: "t" }],
    });

    const blocks = buildImageContentBlocks(Buffer.from("png-data"), "image/png", "/tmp/image.png", "uploaded image");
    expect(blocks[0].image_url.url).toContain("data:image/png;base64,");
    expect(blocks[0].meta.path).toBe("/tmp/image.png");
    expect(blocks[1]).toEqual({ type: "text", text: "uploaded image" });
  });

  it("extracts incremental thinking deltas", async () => {
    const extractor = new IncrementalThinkExtractor();
    const emitted: string[] = [];

    expect(
      await extractor.feed("<think>step one</think>answer", async (text) => {
        emitted.push(text);
      }),
    ).toBe(true);
    expect(
      await extractor.feed("<think>step one and two</think>answer", async (text) => {
        emitted.push(text);
      }),
    ).toBe(true);
    expect(
      await extractor.feed("<think>step one and two</think>answer", async (text) => {
        emitted.push(text);
      }),
    ).toBe(false);

    expect(emitted).toEqual(["step one", "and two"]);
  });

  it("finds legal message starts and stringifies only text blocks", () => {
    expect(
      findLegalMessageStart([
        { role: "tool", tool_call_id: "missing", content: "orphan" },
        { role: "user", content: "next" },
      ]),
    ).toBe(1);
    expect(
      findLegalMessageStart([
        { role: "assistant", tool_calls: [{ id: "call-1" }] },
        { role: "tool", tool_call_id: "call-1", content: "ok" },
      ]),
    ).toBe(0);
    expect(
      stringifyTextBlocks([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
    expect(stringifyTextBlocks([{ type: "image_url" }])).toBeNull();
  });

  it("persists oversized tool results and keeps workspace templates non-destructive", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-helpers-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const reference = maybePersistToolResult(workspace, "chat:one", "call-1", "x".repeat(64), {
      maxChars: 10,
    });
    expect(reference).toContain("[tool output persisted]");
    expect(reference).toContain("call-1.txt");
    expect(fs.existsSync(path.join(workspace, ".memmy", "tool-results", safeFilename("chat:one"), "call-1.txt"))).toBe(true);

    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "custom", "utf8");
    const added = syncWorkspaceTemplates(workspace);
    expect(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8")).toBe("custom");
    expect(added).not.toContain(path.join("memory", "MEMORY.md"));
    expect(added).not.toContain("TOOLS.md");
    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "memory", ".dreamCursor"))).toBe(false);

    const enabledWorkspace = path.join(root, "enabled-workspace");
    const enabledAdded = syncWorkspaceTemplates(enabledWorkspace, undefined, {
      fileMemoryEnabled: true,
    });
    expect(enabledAdded).toContain(path.join("memory", "MEMORY.md"));
    expect(fs.existsSync(path.join(enabledWorkspace, ".git"))).toBe(true);
    expect(
      fs.existsSync(path.join(enabledWorkspace, "memory", ".dreamCursor")),
    ).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
