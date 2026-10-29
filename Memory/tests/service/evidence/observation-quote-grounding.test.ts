import { describe, expect, it } from "vitest";
import { resolveObservationQuote } from "../../../src/service/evidence/observation-quote-grounding.js";

describe("observation quote resolution", () => {
  it("restores balanced Markdown bold markers from the original source", () => {
    const source = '- **业务时点**: “2026-10-22 开工前”，计划周 “2026-10-19 — 2026-10-23”。';
    const quote = '业务时点: “2026-10-22 开工前”，计划周 “2026-10-19 — 2026-10-23”。';
    expect(resolveObservationQuote([source], quote)).toBe(source.slice(2));
  });

  it("restores only the selected original span, preserving internal Markdown and newlines", () => {
    const source = "环境信息\n- **角色**: 计划专员\n- **业务时点**: 2026-10-22 开工前\n- **其他**: 只读";
    const result = resolveObservationQuote([source], "角色: 计划专员\n- 业务时点: 2026-10-22 开工前");
    expect(result).toBe("**角色**: 计划专员\n- **业务时点**: 2026-10-22 开工前");
    expect(source).toContain(result);
  });

  it("preserves exact quotations beginning inside paired formatting", () => {
    const source = "- **角色**: 计划专员";
    expect(resolveObservationQuote([source], "角色**:   计划专员")).toBe("**角色**: 计划专员");
  });

  it.each(["...", "…", "……"])("restores a same-line %s omission to its full source span", (ellipsis) => {
    const source = "签名请求需要访问密钥，系统要求输入密码，用户两次点击拒绝。\n流程未获授权。";
    expect(resolveObservationQuote([source], `签名请求需要访问密钥${ellipsis}用户两次点击拒绝`))
      .toBe("签名请求需要访问密钥，系统要求输入密码，用户两次点击拒绝");
  });

  it("keeps literal source ellipses intact", () => {
    expect(resolveObservationQuote(["等待中...仍未确认。"], "等待中...仍未确认。")).toBe("等待中...仍未确认。");
  });

  it("preserves normalization compatibility and original UTF-16 offsets", () => {
    const source = "前缀👩🏽‍💻 **Cafe\u0301**：  \r\n  ﬁnal ２００ 件。 后缀";
    expect(resolveObservationQuote([source], "Café: final 200 件。"))
      .toBe("**Cafe\u0301**：  \r\n  ﬁnal ２００ 件。");
  });

  it("requires correction for cross-line omissions even within one product list", () => {
    const source = ["- **Q305**:", "    - 可用产线: L1、L2", "    - 工时: 单件 0.02小时 / 件, 换线 0.5小时",
      "    - 批次约束: 单日整批，不拆分", "- **Q306**:", "    - 状态: 锁定批次，不调整"].join("\n");
    const resolved = resolveObservationQuote([source], "Q305... 可用产线: L1、L2... 批次约束: 单日整批，不拆分");
    expect(resolved).toBeUndefined();
    expect(resolveObservationQuote([source], "Q306... 状态: 锁定批次，不调整"))
      .toBeUndefined();
    const continuous = "Q306**:\n    - 状态: 锁定批次，不调整";
    expect(source).toContain(resolveObservationQuote([source], continuous));
  });

  it("restores optional bold only for a complete Markdown table cell", () => {
    const source = "| **Q305** | L1 | 单日整批 |";
    expect(resolveObservationQuote([source], "| Q305 | L1 | 单日整批 |")).toBe(source);
    expect(resolveObservationQuote(["prefix | **Q305** | suffix"], "prefix | Q305 | suffix")).toBeUndefined();
  });

  it("does not infer missing code-fence context in a retained tail", () => {
    const head = "开始片段包含正文和截断前的代码围栏。\n```text\n";
    const tail = "**审批状态**: 尚未确认\n```";
    expect(resolveObservationQuote([head, tail], "审批状态: 尚未确认")).toBeUndefined();
    expect(resolveObservationQuote([head, tail], "**审批状态**: 尚未确认")).toBe("**审批状态**: 尚未确认");
    expect(resolveObservationQuote(["头部内容", "| **Q305** | L1 |"], "| Q305 | L1 |")).toBeUndefined();
  });

  it("requires correction for omitted sibling properties without their owner", () => {
    const source = ["- **可见内容**:", "  - **物料状态详情**:", "    - 已检可用量（扣除预留）：200件。",
      "    - 入库日期：2026-10-22。", "    - 检验状态：已检合格，状态正常。", "    - 来源批次：BATCH-01。",
      "  - **其他事项**:", "    - 状态：尚未确认。"].join("\n");
    expect(resolveObservationQuote([source], "已检可用量（扣除预留）：200件。... 来源批次：BATCH-01。"))
      .toBeUndefined();
  });

  it.each([
    ["plain lines", "已确认 A 方案可行。\nB 方案被否决。", "已确认 A 方案...B 方案被否决"],
    ["peer product subtrees", "- 产品:\n  - **P204**:\n    - 可用产线: L1\n  - **P205**:\n    - 可用产线: L2", "P204...可用产线: L2"],
    ["flat product list", "- 产品:\n  - P204: 已检可用量200件\n  - P205: 已检可用量0件", "P204: 已检可用量200件...P205: 已检可用量0件"],
    ["natural-language product names", "- 产品:\n  - 普通泵: 已检可用量200件\n  - 增压泵: 已检可用量0件", "普通泵: 已检可用量200件...增压泵: 已检可用量0件"],
    ["blank boundary", "- 物料:\n  - 可用数量: 200件\n\n  - 来源批次: BATCH-01", "可用数量: 200件...来源批次: BATCH-01"],
    ["heading boundary", "- 物料:\n  - 可用数量: 200件\n## 另一产品\n  - 来源批次: BATCH-01", "可用数量: 200件...来源批次: BATCH-01"],
    ["table rows", "| P204 | 200件 |\n| P205 | 0件 |", "P204...P205"],
    ["fenced code", "```text\n- 物料:\n  - 可用数量: 200件\n  - 来源批次: BATCH-01\n```", "可用数量: 200件...来源批次: BATCH-01"]
  ])("rejects an omission across %s", (_name, source, quote) => {
    expect(resolveObservationQuote([source!], quote!)).toBeUndefined();
  });

  it("never joins separate retained fragments", () => {
    expect(resolveObservationQuote(["已确认采购审批状态。", "采购尚未完成，需继续跟进。"], "已确认采购审批状态...采购尚未完成"))
      .toBeUndefined();
  });

  it.each([
    ["`**approval**` is required", "approval is required"],
    ["```text\n**approval** is required\n```", "approval is required"],
    ["    ```text\n    **approval** is required\n    ```", "approval is required"],
    ["    **approval** is required", "approval is required"],
    ["amount ** 2 ** rate", "amount 2 rate"],
    ["amount **2** rate", "amount 2 rate"],
    ["amount**2**rate", "amount2rate"],
    ["result = 2 **n** 3", "result = 2 n 3"],
    ["yield = base **power** cap", "yield = base power cap"],
    ["Ordinary **approval** is required", "Ordinary approval is required"],
    ["\\**approval** is required", "approval is required"],
    ["order_id: ABC_204", "orderid: ABC204"],
    ["**未批准**: 200件", "已批准: 200件"],
    ["**可用数量**: 200件", "可用数量: 300件"],
    ["**入库日期**: 2026-10-22", "入库日期: 2026-10-23"]
  ])("does not change code, operators, identifiers, or meaning: %s", (source, quote) => {
    expect(resolveObservationQuote([source!], quote!)).toBeUndefined();
  });

  it("retains the existing single-line omitted-gap limit", () => {
    const source = `开头证据${"中".repeat(41)}结尾证据`;
    expect(resolveObservationQuote([source], "开头证据...结尾证据")).toBeUndefined();
  });

  it("limits the complete restored quotation, including omitted text", () => {
    const source = `- 业务:\n  - 开头证据: ${"中".repeat(780)}\n  - 结尾证据: 仍待确认`;
    expect(resolveObservationQuote([source], "开头证据...结尾证据: 仍待确认")).toBeUndefined();
    expect(resolveObservationQuote(["证据".repeat(401)], "证据".repeat(401))).toBeUndefined();
  });
});
