import { describe, expect, it } from "vitest";
import { compileWindowsPolicy, parseNativePolicy } from "../../../../src/tools/computer-history/win/policy.js";
import { parseWindowsSettings } from "../../../../src/tools/computer-history/win/settings.js";
import { SnapshotNormalizer } from "../../../../src/tools/computer-history/win/normalize.js";
import { parseNativeEvent, type NativeNode, type NativeSnapshotEvent } from "../../../../src/tools/computer-history/win/protocol.js";
import { context, envelope, full, root, stats } from "./fixtures.js";

const executable = "C:\\Apps\\Code.exe";
const scope = { controlType: "Edit", automationId: "", scope: "vscode.editor" };
const binding = { ...context, executable };
const policy = compileWindowsPolicy([{ executable }], [binding]);
function tree(): NativeNode[] {
  const node = (id: number, type: NativeNode["controlType"], automationId: string): NativeNode => ({ ...root,
    key: id.toString(16).padStart(16, "0"), parentKey: (id - 1).toString(16).padStart(16, "0"),
    runtimeId: String(id), depth: id - 1, controlType: type, automationId, name: undefined });
  return [{ ...root, name: undefined } as NativeNode, node(2, "Group", "workbench.parts.editor"), node(3, "Group", ""), node(4, "Text", ""),
    { ...node(5, "Edit", ""), name: "synthetic.txt", text: "SYNTHETIC-DOCUMENT-CONTENT", documentStatus: "available" }];
}
function snapshot(nodes = tree()) {
  return parseNativeEvent({ ...full(nodes), context: binding }) as NativeSnapshotEvent;
}
const normalize = (nodes = tree()) => new SnapshotNormalizer().normalize(snapshot(nodes), policy, "revision");

describe("application document defaults", () => {
  it("adds defaults only to consented bound instances; explicit empty/custom rules win", () => {
    expect(policy.applications[0]?.documentRegions).toEqual([scope]);
    const word = { ...binding, executable: "C:\\Office\\WINWORD.EXE" };
    expect(compileWindowsPolicy([], [word], { defaultApplicationBehavior: "observe" }).applications[0]?.documentRegions)
      .toEqual([{ controlType: "Edit", automationId: "Body" }, { controlType: "Document", automationId: "", scope: "word.document" }]);
    expect(() => compileWindowsPolicy([], [binding])).toThrow();
    expect(() => compileWindowsPolicy([], [binding], { defaultApplicationBehavior: "observe", deny: { executables: [executable] } })).toThrow();
    expect(compileWindowsPolicy([{ executable, documentRegions: [] }], [binding]).applications[0]?.documentRegions).toEqual([]);
    const custom = [{ controlType: "Document" as const, automationId: "custom" }];
    expect(compileWindowsPolicy([{ executable, documentRegions: custom }], [binding]).applications[0]?.documentRegions).toEqual(custom);
  });
  it("round trips the explicit scope through persistent settings", () => {
    expect(parseWindowsSettings({ version: 1, applications: [{ executable, documentRegions: [scope] }] }).applications[0]?.documentRegions).toEqual([scope]);
  });
  it.each([
    { documentRegions: [{ controlType: "Edit", automationId: "" }] },
    { documentRegions: [{ ...scope, scope: "anything" }] },
    { documentRegions: [{ ...scope, automationId: "not-empty" }] },
    { documentRegions: [{ ...scope, controlType: "Document" }] },
    { documentRegions: [scope], executable: "C:\\Apps\\Other.exe" },
    { searchFields: [scope] },
  ])("rejects unbounded or incorrectly scoped selectors", (changes) => {
    expect(() => parseNativePolicy({ version: 1, applications: [{ pid: binding.pid, executable,
      processStart: binding.processStart, hwnd: binding.hwnd, ...changes }] })).toThrow();
  });
});

describe("Word document scope", () => {
  const wordBinding = { ...binding, executable: "C:\\Office\\WINWORD.EXE" };
  const wordPolicy = compileWindowsPolicy([{ executable: wordBinding.executable }], [wordBinding]);
  const nodes = (): NativeNode[] => ([
    { ...root, className: "OpusApp", name: undefined },
    { ...root, key: "0000000000000002", runtimeId: "2", parentKey: root.key, depth: 1, controlType: "Pane", className: "_WwF", name: undefined },
    { ...root, key: "0000000000000003", runtimeId: "3", parentKey: "0000000000000002", depth: 2, controlType: "Pane", className: "_WwB", name: undefined },
    { ...root, key: "0000000000000004", runtimeId: "4", parentKey: "0000000000000003", depth: 3, controlType: "Document", className: "_WwG",
      name: "synthetic.rtf", text: "SYNTHETIC-WORD-BODY", visibleText: "SYNTHETIC-WORD-BODY", documentStatus: "available" },
  ] as NativeNode[]).map((node) => ({ ...node, automationId: "" }));
  const event = (items = nodes()) => parseNativeEvent({ ...full(items), context: wordBinding }) as NativeSnapshotEvent;
  const normalizeWord = (items = nodes()) => new SnapshotNormalizer().normalize(event(items), wordPolicy, "r");
  it("permits only a Word document rooted in its exact window class chain", () => {
    expect(JSON.stringify(normalizeWord())).toContain("SYNTHETIC-WORD-BODY");
    expect(normalizeWord()?.accessibility?.nodes.at(-1)?.documentContext).toBeUndefined();
    expect(normalizeWord()?.accessibility?.nodes.at(-1)?.documentEvidence).toMatchObject({ adapter: "word.document",
      labelKind: "document_label", labelSource: "uia.name", textSource: "uia.document_range", visibleTextSource: "uia.visible_ranges" });
    expect(parseWindowsSettings({ version: 1, applications: [{ executable: wordBinding.executable,
      documentRegions: [{ controlType: "Document", automationId: "", scope: "word.document" }] }] }).applications[0]?.documentRegions).toHaveLength(1);
    expect(() => parseNativePolicy({ ...wordPolicy, applications: [{ ...wordPolicy.applications[0], executable }] })).toThrow();
  });
  it.each([
    (items: NativeNode[]) => { items[0]!.className = "#32770"; },
    (items: NativeNode[]) => { items[1]!.className = "searchPane"; },
    (items: NativeNode[]) => { delete items[2]!.className; },
    (items: NativeNode[]) => { items[3]!.className = "RichEdit"; },
    (items: NativeNode[]) => { items[2]!.controlType = "Group"; },
    (items: NativeNode[]) => { items[1]!.password = null; },
    (items: NativeNode[]) => { items[3]!.password = true; },
    (items: NativeNode[]) => { items[2]!.missing = ["automationId"]; },
    (items: NativeNode[]) => { items[3]!.automationId = "search"; },
    (items: NativeNode[]) => { delete items[3]!.documentStatus; },
    (items: NativeNode[]) => { items[3]!.value = "private input"; },
  ])("rejects invalid metadata without falling back to a generic empty Document", (mutate) => {
    const items = nodes(); mutate(items); expect(() => normalizeWord(items)).toThrow("snapshot_invalid");
  });
  it("rechecks changed window classes in a delta and rejects descendants of an authorized document", () => {
    const normalizer = new SnapshotNormalizer(); normalizer.normalize(event(), wordPolicy, "r");
    const changed = { ...nodes()[1]!, className: "dialog" };
    const delta = parseNativeEvent({ ...envelope(2), kind: "snapshot", context: wordBinding, trigger: { kinds: ["sample"], count: 1 },
      snapshot: { status: "ok", reason: null, mode: "delta", added: [changed], removed: [changed.key], unchangedCount: 3,
        focusKey: null, truncated: false, truncation: [], stats: stats(4), elapsedMs: 3 } }) as NativeSnapshotEvent;
    expect(() => normalizer.normalize(delta, wordPolicy, "r")).toThrow("snapshot_invalid");
    const items = nodes();
    items.push({ ...root, controlType: "Text", key: "0000000000000005", parentKey: items[3]!.key, depth: 4, name: "private input echo" });
    expect(() => normalizeWord(items)).toThrow("snapshot_invalid");
  });
});

describe("independent TS document privacy boundary", () => {
  it("accepts the bounded editor and preserves availability evidence", () => {
    expect(JSON.stringify(normalize())).toContain("SYNTHETIC-DOCUMENT-CONTENT");
    expect(normalize()?.accessibility?.nodes.at(-1)?.documentStatus).toBe("available");
    expect(normalize()?.accessibility?.nodes.at(-1)?.documentContext).toBe("vscode.editor");
    expect(normalize()?.accessibility?.nodes.at(-1)?.documentEvidence).toEqual({ adapter: "vscode.editor",
      labelKind: "editor_label", labelSource: "uia.name", textSource: "uia.document_range", providerFocused: false });
  });
  it("does not accept native assertions of document context authority", () => {
    const nodes = tree();
    expect(() => snapshot(nodes.map((node) => ({ ...node, documentContext: "vscode.editor" })))).toThrow();
    expect(() => snapshot(nodes.map((node) => ({ ...node, documentEvidence: { adapter: "vscode.editor" } })))).toThrow();
  });
  it.each([
    (nodes: NativeNode[]) => { nodes[1]!.automationId = "workbench.parts.auxiliarybar"; },
    (nodes: NativeNode[]) => { nodes[3]!.controlType = "Group"; },
    (nodes: NativeNode[]) => { nodes[2]!.password = true; },
    (nodes: NativeNode[]) => { nodes[3]!.password = null; },
    (nodes: NativeNode[]) => { nodes[1]!.missing = ["automationId"]; },
    (nodes: NativeNode[]) => { nodes[4]!.missing = ["automationId"]; },
    (nodes: NativeNode[]) => { nodes[4]!.password = true; },
    (nodes: NativeNode[]) => { delete nodes[4]!.documentStatus; },
    (nodes: NativeNode[]) => { nodes[4]!.documentStatus = "label_only"; },
    (nodes: NativeNode[]) => { nodes[4]!.text = " synthetic.txt\n"; },
    (nodes: NativeNode[]) => { nodes[4]!.value = "ordinary input"; },
  ])("rejects a forged or out-of-scope body", (mutate) => {
    const nodes = tree(); mutate(nodes); expect(() => normalize(nodes)).toThrow("snapshot_invalid");
  });
  it("does not let a sensitive ancestor grant a descendant body exception", () => {
    const sensitive = parseNativePolicy({ ...policy, sensitiveAutomationIds: ["workbench.parts.editor"] });
    expect(() => new SnapshotNormalizer().normalize(snapshot(), sensitive, "r")).toThrow("snapshot_invalid");
  });
  it("rejects input echoed into a sibling live-region label", () => {
    const nodes = tree();
    nodes.push({ ...nodes[3]!, key: "0000000000000006", runtimeId: "6", parentKey: nodes[0]!.key,
      depth: 1, name: "No results for SYNTHETIC-PRIVATE-QUERY" });
    expect(() => normalize(nodes)).toThrow("snapshot_invalid");
  });
  it.each(["workbench.parts.auxiliarybar", "workbench.parts.panel", "workbench.view.search", "quickInput_list"])(
    "does not authorize empty-ID input under %s", (automationId) => {
      const nodes = tree(); nodes[1]!.automationId = automationId;
      expect(() => normalize(nodes)).toThrow("snapshot_invalid");
    });
  it("accepts content-free unavailable states and recomputes the scope after a delta", () => {
    const nodes = tree(); const body = nodes[4]!;
    delete body.name; delete body.text; body.redaction = "edit_control"; body.documentStatus = "label_only";
    expect(normalize(nodes)?.accessibility?.nodes.at(-1)).toMatchObject({ documentStatus: "label_only", redaction: "edit_control" });
    expect(normalize(nodes)?.accessibility?.nodes.at(-1)?.documentContext).toBeUndefined();
    expect(normalize(nodes)?.accessibility?.nodes.at(-1)?.documentEvidence).toBeUndefined();
    const normalizer = new SnapshotNormalizer(); normalizer.normalize(snapshot(), policy, "r");
    const changed = tree()[1]!; changed.automationId = "workbench.parts.panel";
    const delta = parseNativeEvent({ ...envelope(2), kind: "snapshot", context: binding, trigger: { kinds: ["sample"], count: 1 },
      snapshot: { status: "ok", reason: null, mode: "delta", added: [changed], removed: [changed.key], unchangedCount: 4,
        focusKey: null, truncated: false, truncation: [], stats: stats(5), elapsedMs: 3 } }) as NativeSnapshotEvent;
    expect(() => normalizer.normalize(delta, policy, "r")).toThrow("snapshot_invalid");
  });
});
