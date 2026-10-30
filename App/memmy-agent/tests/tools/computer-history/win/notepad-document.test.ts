import { describe, expect, it } from "vitest";
import { compileWindowsPolicy, parseNativePolicy } from "../../../../src/tools/computer-history/win/policy.js";
import { SnapshotNormalizer } from "../../../../src/tools/computer-history/win/normalize.js";
import { parseNativeEvent, type NativeNode, type NativeSnapshotEvent } from "../../../../src/tools/computer-history/win/protocol.js";
import { context, envelope, full, root, stats } from "./fixtures.js";

const binding = { ...context, executable: "C:\\Program Files\\WindowsApps\\Notepad\\Notepad.exe" };
const scope = { controlType: "Document" as const, automationId: "" as const, scope: "notepad.document" as const };
const policy = compileWindowsPolicy([{ executable: binding.executable }], [binding]);
const tree = (): NativeNode[] => [
  { ...root, automationId: "", className: "Notepad", name: "sample.txt - Notepad" },
  { ...root, automationId: "", key: "0000000000000002", parentKey: root.key, runtimeId: "2", depth: 1,
    controlType: "Pane", className: "NotepadTextBox", name: undefined },
  { ...root, automationId: "", key: "0000000000000003", parentKey: "0000000000000002", runtimeId: "3", depth: 2,
    controlType: "Document", className: "RichEditD2DPT", name: "Text editor", text: "NOTEPAD-BODY\r\n",
    visibleText: "NOTEPAD-BODY\r\n", focused: true, documentStatus: "available" },
] as NativeNode[];
const event = (nodes = tree()) => parseNativeEvent({ ...full(nodes), context: binding }) as NativeSnapshotEvent;
const normalize = (nodes = tree()) => new SnapshotNormalizer().normalize(event(nodes), policy, "revision");

describe("Notepad bounded document capture", () => {
  it("adds a default only after app binding, preserves explicit rules and keeps budgets", () => {
    expect(policy.applications[0]?.documentRegions).toEqual([scope]);
    expect(policy.limits).toMatchObject({ queryBudgetMs: 650, workerTimeoutMs: 1500 });
    expect(compileWindowsPolicy([{ executable: binding.executable, documentRegions: [] }], [binding])
      .applications[0]?.documentRegions).toEqual([]);
    expect(() => compileWindowsPolicy([], [binding])).toThrow();
    expect(() => parseNativePolicy({ ...policy, applications: [{ ...policy.applications[0], executable: "C:\\Other.exe" }] })).toThrow();
    expect(() => parseNativePolicy({ ...policy, applications: [{ ...policy.applications[0],
      documentRegions: [{ controlType: "Document", automationId: "" }] }] })).toThrow();
  });
  it("retains provider body evidence without claiming the generic editor label is a filename", () => {
    expect(normalize()?.accessibility?.nodes.at(-1)).toMatchObject({ text: "NOTEPAD-BODY\r\n", documentStatus: "available",
      documentEvidence: { adapter: "notepad.document", labelKind: "document_label", labelSource: "uia.name",
        textSource: "uia.document_range", visibleTextSource: "uia.visible_ranges", providerFocused: true } });
    expect(normalize()?.accessibility?.nodes.at(-1)?.documentContext).toBeUndefined();
  });
  it.each([
    (nodes: NativeNode[]) => { nodes[0]!.className = "#32770"; },
    (nodes: NativeNode[]) => { nodes[1]!.className = "SearchPane"; },
    (nodes: NativeNode[]) => { nodes[1]!.password = null; },
    (nodes: NativeNode[]) => { nodes[1]!.redaction = "sensitive_id"; },
    (nodes: NativeNode[]) => { nodes[2]!.className = "RichEdit50W"; },
    (nodes: NativeNode[]) => { nodes[2]!.missing = ["automationId"]; },
    (nodes: NativeNode[]) => { nodes[2]!.automationId = "search"; },
    (nodes: NativeNode[]) => { nodes[2]!.password = true; },
    (nodes: NativeNode[]) => { nodes[2]!.text = "Text editor\r\n"; },
    (nodes: NativeNode[]) => { delete nodes[2]!.documentStatus; },
    (nodes: NativeNode[]) => { nodes[2]!.value = "ordinary input"; },
  ])("rejects malformed, sensitive, password, label-only and unauthorized content", (mutate) => {
    const nodes = tree(); mutate(nodes); expect(() => normalize(nodes)).toThrow("snapshot_invalid");
  });
  it("rechecks ancestry on deltas rather than reusing a previous frame's adapter", () => {
    const normalizer = new SnapshotNormalizer(); normalizer.normalize(event(), policy, "r");
    const changed = { ...tree()[1]!, className: "Dialog" };
    const delta = parseNativeEvent({ ...envelope(2), kind: "snapshot", context: binding, trigger: { kinds: ["sample"], count: 1 },
      snapshot: { status: "ok", reason: null, mode: "delta", added: [changed], removed: [changed.key], unchangedCount: 2,
        focusKey: null, truncated: false, truncation: [], stats: stats(3), elapsedMs: 3 } }) as NativeSnapshotEvent;
    expect(() => normalizer.normalize(delta, policy, "r")).toThrow("snapshot_invalid");
  });
  it("preserves partial captures and never treats them as delta baselines", () => {
    const normalizer = new SnapshotNormalizer();
    const partial = event();
    if (partial.snapshot.status !== "ok") throw new Error("invalid fixture");
    partial.snapshot.truncated = true; partial.snapshot.truncation = ["budget_ms"];
    expect(normalizer.normalize(partial, policy, "r")?.accessibility?.truncated).toBe(true);
    expect(normalizer.operationObservation().truncated).toBe(true);
  });
});
