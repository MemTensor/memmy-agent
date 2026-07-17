import { describe, expect, it } from "vitest";
import { FeishuChannel } from "../../../src/integrations/channels/feishu.js";

function md(content: string): Record<string, any> {
  return { tag: "markdown", content };
}

function table(value = "v"): Record<string, any> {
  return {
    tag: "table",
    columns: [{ tag: "column", name: "c0", display_name: "A", width: "auto" }],
    rows: [{ c0: value }],
    page_size: 2,
  };
}

describe("Feishu table splitting", () => {
  it("keeps empty and non-table element lists in one group", () => {
    expect(FeishuChannel.splitElementsByTableLimit([])).toEqual([[]]);
    const elements = [{ tag: "markdown", content: "hello" }];
    expect(FeishuChannel.splitElementsByTableLimit(elements)).toEqual([elements]);
  });

  it("splits multiple table elements into separate groups", () => {
    const intro = { tag: "markdown", content: "intro" };
    const t1 = { tag: "table", name: "a" };
    const t2 = { tag: "table", name: "b" };
    const tail = { tag: "markdown", content: "tail" };

    expect(FeishuChannel.splitElementsByTableLimit([intro, t1, t2, tail])).toEqual([[intro, t1], [t2, tail]]);
  });

  it("keeps a single table in one group", () => {
    const elements = [md("intro"), table(), md("outro")];

    expect(FeishuChannel.splitElementsByTableLimit(elements)).toEqual([elements]);
  });

  it("splits two distinct tables into two groups", () => {
    const t1 = table("table-one");
    const t2 = {
      tag: "table",
      columns: [{ tag: "column", name: "c0", display_name: "B", width: "auto" }],
      rows: [{ c0: "table-two" }],
      page_size: 2,
    };

    const result = FeishuChannel.splitElementsByTableLimit([md("before"), t1, md("between"), t2, md("after")]);

    expect(result).toHaveLength(2);
    expect(result[0]).toContain(t1);
    expect(result[0]).not.toContain(t2);
    expect(result[1]).toContain(t2);
    expect(result[1]).not.toContain(t1);
  });

  it("splits three tables into three groups", () => {
    const tables = [table("t0"), table("t1"), table("t2")];
    const result = FeishuChannel.splitElementsByTableLimit(tables);

    expect(result).toHaveLength(3);
    expect(result[0]).toContain(tables[0]);
    expect(result[1]).toContain(tables[1]);
    expect(result[2]).toContain(tables[2]);
  });

  it("keeps leading markdown with the first table", () => {
    const intro = md("intro");
    const t = table();

    expect(FeishuChannel.splitElementsByTableLimit([intro, t])).toEqual([[intro, t]]);
  });

  it("keeps trailing markdown after the second table", () => {
    const t1 = table("one");
    const t2 = table("two");
    const tail = md("end");

    expect(FeishuChannel.splitElementsByTableLimit([t1, t2, tail])).toEqual([[t1], [t2, tail]]);
  });

  it("keeps non-table elements before the first table in the first group", () => {
    const head = md("head");
    const t1 = table("one");
    const t2 = table("two");

    expect(FeishuChannel.splitElementsByTableLimit([head, t1, t2])).toEqual([[head, t1], [t2]]);
  });
});
