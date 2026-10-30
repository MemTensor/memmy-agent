import path from "node:path";
import { scrubRecord, type HistoryEvent } from "../core/recording.js";
import { authorizedRule, pathKey, windowsApplicationId, type NativePolicy } from "./policy.js";
import type { NativeNode, NativeSnapshotEvent } from "./protocol.js";
import { documentTextIsLabel, isVsCodeEditorBody, isWordDocument, isNotepadDocument } from "./document-regions.js";
import type { RecordingObservation } from "@memmy/local-api-contracts";

const operationRoles = new Set(["Button", "CheckBox", "ComboBox", "Hyperlink", "ListItem", "MenuItem",
  "RadioButton", "Slider", "Spinner", "TabItem", "TreeItem", "SplitButton"]);

const structural = new Set(["Window", "Pane", "Group", "Custom", "MenuBar", "StatusBar", "Tab", "ToolBar",
  "List", "Tree", "DataGrid", "Header", "Table", "TitleBar", "SemanticZoom", "AppBar"]);
const fields = ["name", "text", "visibleText", "value"] as const;
const invalid = (): never => { throw new Error("windows_snapshot_invalid"); };

// Native hashes identify nodes within a baseline; they confer no permission.
export class SnapshotNormalizer {
  private baseline: Map<string, NativeNode> | null = null;
  private identity: string | null = null;
  private frameNodes: Map<string, NativeNode> | null = null;
  reset(): void { this.baseline = null; this.identity = null; this.frameNodes = null; }
  /** Only validated, non-sensitive control labels/geometry; never field values or document bodies. */
  operationObservation(): RecordingObservation {
    const eligible = [...(this.frameNodes?.values() ?? [])].filter((node) => operationRoles.has(node.controlType)
      && node.password === false && !node.redaction && !node.providerOffscreen && !node.documentStatus);
    return { source: "windows_uia", truncated: !this.baseline || eligible.length > 256,
      nodes: eligible.slice(0, 256).map((node) => ({ key: node.key, role: node.controlType, focused: node.focused,
        ...(node.name ? { name: scrubRecord(node.name).slice(0, 240) } : {}),
        ...(node.automationId ? { automation_id: scrubRecord(node.automationId).slice(0, 256) } : {}),
        ...(node.bounds && node.bounds[2] > 0 && node.bounds[3] > 0 ? { bounds: node.bounds } : {}),
      })) };
  }
  normalizeEvents(event: NativeSnapshotEvent, policy: NativePolicy, revision: string): HistoryEvent[] {
    const normalized = this.normalize(event, policy, revision);
    if (!normalized || event.snapshot.status !== "ok") return [];
    const focus = event.snapshot.focusKey ? this.frameNodes?.get(event.snapshot.focusKey) : null;
    const events: HistoryEvent[] = [];
    for (const [index, action] of (event.snapshot.actions ?? []).entries()) {
      if (action.type === "key_press" || action.type === "text_input") {
        if (!focus || focus.password !== false || (focus.redaction && focus.redaction !== "edit_control")) { this.reset(); return invalid(); }
      }
      const age = Date.parse(event.timestamp) - Date.parse(action.timestamp);
      if (age < -1000 || age > 60000) { this.reset(); return invalid(); }
      const details: Record<string, unknown> = { ...normalized.details, source: "low_level_hook", injected: action.injected, actionIndex: index };
      if (action.type === "key_press") details.keys = [action.key];
      if (action.type === "mouse_click") { details.button = action.button; details.x = action.x; details.y = action.y; }
      if (action.type === "scroll") { details.direction = action.direction; details.delta = action.delta; }
      if (action.type === "text_input") { details.pressCount = action.pressCount; details.unit = action.unit; details.redacted = true; }
      events.push({ eventType: action.type, timestamp: action.timestamp, application: normalized.application, details });
    }
    return [...events, normalized];
  }

  normalize(event: NativeSnapshotEvent, policy: NativePolicy, revision: string): HistoryEvent | null {
    try { return this.apply(event, policy, revision); }
    catch (error) { this.reset(); throw error; }
  }
  private apply(event: NativeSnapshotEvent, policy: NativePolicy, revision: string): HistoryEvent | null {
    const snapshot = event.snapshot;
    const context = event.context;
    if (snapshot.status !== "ok") { this.reset(); return null; }
    if (!context || context.minimized) return invalid();
    const rule = authorizedRule(policy, context);
    if (!rule) { this.reset(); throw new Error("windows_application_not_authorized"); }
    const identity = [context.pid, context.processStart, context.hwnd, pathKey(context.executable), context.generation, revision].join("|");
    const nodes = snapshot.mode === "full" ? new Map<string, NativeNode>() : new Map(this.baseline ?? []);
    if (snapshot.mode === "delta") {
      if (!this.baseline || this.identity !== identity || snapshot.truncated) return invalid();
      const removed = new Set(snapshot.removed);
      if (removed.size !== snapshot.removed.length) return invalid();
      for (const key of removed) if (!nodes.delete(key)) return invalid();
      if (snapshot.unchangedCount !== nodes.size) return invalid();
    }
    for (const node of snapshot.mode === "full" ? snapshot.nodes : snapshot.added) {
      if (nodes.has(node.key)) return invalid();
      nodes.set(node.key, node);
    }
    if (nodes.size > policy.limits.maxNodes || snapshot.stats.emitted !== nodes.size
        || snapshot.truncated !== (snapshot.truncation.length > 0)) return invalid();
    const sensitive = new Set([...(policy.sensitiveAutomationIds ?? []), ...(rule.sensitiveAutomationIds ?? [])]
      .map((value) => value.toLowerCase()));
    const matches = (selectors: typeof rule.documentRegions, node: NativeNode): boolean =>
      !!selectors?.some((selector) => !("scope" in selector) && selector.controlType === node.controlType && selector.automationId === node.automationId);
    let roots = 0;
    let total = 0;
    const blocks = new Set<string>();
    // Authority is recomputed for each full/delta frame, once per node. Rendering
    // reuses that result instead of walking the same ancestry several more times.
    const adapters = new Map<string, "vscode.editor" | "word.document" | "notepad.document">();
    const boundedEditor = rule.documentRegions?.some((selector) => "scope" in selector && selector.scope === "vscode.editor");
    for (const node of nodes.values()) {
      if (node.depth > policy.limits.maxDepth) return invalid();
      if (node.parentKey === null) { if (node.depth !== 0) return invalid(); ++roots; }
      else {
        const parent = nodes.get(node.parentKey);
        if (!parent || node.depth !== parent.depth + 1) return invalid();
      }
      const content = fields.some((field) => node[field] !== undefined);
      const masked = sensitive.has(node.automationId.toLowerCase()) || node.password !== false;
      const adapter = node.controlType === "Edit" && isVsCodeEditorBody(node, nodes, rule) ? "vscode.editor"
        : node.controlType === "Document" && isWordDocument(node, nodes, rule) ? "word.document"
        : node.controlType === "Document" && isNotepadDocument(node, nodes, rule) ? "notepad.document" : undefined;
      if (adapter) adapters.set(node.key, adapter);
      const scoped = adapter !== undefined;
      const document = matches(rule.documentRegions, node) || scoped;
      const search = node.controlType === "Edit" && node.focused && matches(rule.searchFields, node);
      if ((node.documentStatus && !scoped) || (scoped && content && node.documentStatus !== "available")) return invalid();
      if (node.documentStatus === "available" && (node.name === undefined || node.text === undefined || documentTextIsLabel(node))) return invalid();
      if (node.documentStatus && node.documentStatus !== "available" && (content || node.redaction !== "edit_control")) return invalid();
      if ((node.redaction || masked) && content) return invalid();
      // Input can be echoed into sibling live-region labels outside the Edit subtree.
      if (boundedEditor && !document && !search && content) return invalid();
      if (node.controlType === "Edit" && !document && !search && content) return invalid();
      if ((node.text !== undefined || node.visibleText !== undefined) && !document) return invalid();
      if (node.value !== undefined && (!search || document)) return invalid();
      if (sensitive.has(node.automationId.toLowerCase()) || node.password === true
          || (node.password === null && (node.controlType === "Edit" || !structural.has(node.controlType)))
          || node.controlType === "Edit" || (scoped && !!node.documentStatus)
          || ((node.text !== undefined || node.visibleText !== undefined) && document)) blocks.add(node.key);
      for (const field of fields) {
        const units = node[field]?.length ?? 0;
        if (units > policy.limits.maxNodeTextChars) return invalid();
        total += units;
      }
    }
    if ((nodes.size > 0 && roots !== 1) || total > policy.limits.maxTextChars
        || (snapshot.focusKey !== null && !nodes.get(snapshot.focusKey)?.focused)) return invalid();
    for (const node of nodes.values()) if (node.parentKey && blocks.has(node.parentKey)) return invalid();
    // A partial capture never becomes the basis of a subsequent delta.
    this.baseline = snapshot.truncated ? null : nodes;
    this.identity = snapshot.truncated ? null : identity;
    this.frameNodes = nodes;
    return scrubRecord({ eventType: "accessibility_snapshot", timestamp: event.timestamp,
      application: { id: windowsApplicationId(context.executable), platform: "windows",
        name: path.win32.basename(context.executable), executable: context.executable },
      details: { pid: context.pid, processStart: context.processStart, hwnd: context.hwnd,
        generation: context.generation, policyRevision: revision, nativeSessionId: event.sessionId, nativeSequence: event.sequence,
        sourceMode: snapshot.mode, trigger: event.trigger, truncation: snapshot.truncation, ...(snapshot.actionOverflow ? { actionOverflow: true } : {}) },
      accessibility: { mode: "full", truncated: snapshot.truncated, nodes: [...nodes.values()].map((node) => ({
        key: node.key, parentKey: node.parentKey, controlType: node.controlType,
        providerOffscreen: node.providerOffscreen, ...(node.redaction ? { redaction: node.redaction } : {}),
        ...(node.documentStatus ? { documentStatus: node.documentStatus } : {}),
        ...(node.documentStatus === "available" && !node.redaction && adapters.get(node.key) === "vscode.editor"
          ? { documentContext: "vscode.editor" as const } : {}),
        ...(node.documentStatus === "available" && !node.redaction && adapters.has(node.key)
          ? { documentEvidence: {
            adapter: adapters.get(node.key)!,
            labelKind: adapters.get(node.key) === "vscode.editor" ? "editor_label" as const : "document_label" as const,
            labelSource: "uia.name" as const, textSource: "uia.document_range" as const,
            ...(node.visibleText !== undefined ? { visibleTextSource: "uia.visible_ranges" as const } : {}),
            providerFocused: node.focused,
          } } : {}),
        ...Object.fromEntries(fields.filter((field) => node[field] !== undefined).map((field) => [field, node[field]])),
      })) },
    } satisfies HistoryEvent);
  }
}
