import { describe, expect, it } from "vitest";
import { FeishuChannel } from "../../../src/integrations/channels/feishu.js";

describe("Feishu markdown rendering", () => {
  it("parses markdown tables and strips inline formatting in cells", () => {
    const table = FeishuChannel.parseMarkdownTable(
      "| **Name** | __Status__ | *Notes* | ~~State~~ |\n| --- | --- | --- | --- |\n| **Alice** | __Ready__ | *Fast* | ~~Old~~ |",
    );

    expect(table?.columns.map((col: any) => col.display_name)).toEqual(["Name", "Status", "Notes", "State"]);
    expect(table?.rows).toEqual([{ col_0: "Alice", col_1: "Ready", col_2: "Fast", col_3: "Old" }]);
  });

  it("strips embedded markdown before bolding headings", () => {
    const channel = Object.create(FeishuChannel.prototype) as FeishuChannel;

    expect(channel.splitHeadings("# **Important** *status* ~~update~~")).toEqual([
      {
        tag: "div",
        text: { tag: "lark_md", content: "**Important status update**" },
      },
    ]);
  });

  it("keeps markdown body and code blocks intact after headings", () => {
    const channel = Object.create(FeishuChannel.prototype) as FeishuChannel;

    const elements = channel.splitHeadings("# **Heading**\n\nBody with **bold** text.\n\n```typescript\nconsole.log('hi')\n```");

    expect(elements[0]).toEqual({
      tag: "div",
      text: { tag: "lark_md", content: "**Heading**" },
    });
    expect(elements[1].tag).toBe("markdown");
    expect(elements[1].content).toContain("Body with **bold** text.");
    expect(elements[1].content).toContain("```typescript\nconsole.log('hi')\n```");
  });

  it("detects card-worthy markdown while preserving simple post messages", () => {
    expect(FeishuChannel.detectMessageFormat("| A | B |\n| - | - |")).toBe("interactive");
    expect(FeishuChannel.detectMessageFormat("[docs](https://example.com)")).toBe("post");
    expect(FeishuChannel.detectMessageFormat("plain text")).toBe("text");
  });
});
