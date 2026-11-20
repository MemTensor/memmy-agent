import path from "node:path";
import type { NativeAppRule } from "./policy.js";
import type { NativeNode } from "./protocol.js";

// Recompute from the complete validated tree. A native "scope matched" assertion would
// not be sufficient authority, nor would a dynamic filename/accessible name.
export function isVsCodeEditorBody(node: NativeNode, nodes: ReadonlyMap<string, NativeNode>, rule: NativeAppRule): boolean {
  if (path.win32.basename(rule.executable).toLowerCase() !== "code.exe"
      || !rule.documentRegions?.some((selector) => "scope" in selector && selector.scope === "vscode.editor")
      || node.controlType !== "Edit" || node.automationId !== "" || node.password !== false || node.missing?.includes("automationId")) return false;
  let parent = node.parentKey;
  let depth = node.depth;
  for (const [type, id] of [["Text", ""], ["Group", ""], ["Group", "workbench.parts.editor"]]) {
    const ancestor = parent ? nodes.get(parent) : undefined;
    if (!ancestor || ancestor.controlType !== type || ancestor.automationId !== id || ancestor.depth !== --depth
        || ancestor.password !== false || ancestor.redaction || ancestor.missing?.includes("automationId")) return false;
    parent = ancestor.parentKey;
  }
  return true;
}

export function documentTextIsLabel(node: NativeNode): boolean {
  const trim = (value: string) => value.replace(/^[ \r\n\t]+|[ \r\n\t]+$/gu, "");
  return node.name !== undefined && node.text !== undefined && trim(node.name) !== "" && trim(node.name) === trim(node.text);
}

export function isWordDocument(node: NativeNode, nodes: ReadonlyMap<string, NativeNode>, rule: NativeAppRule): boolean {
  if (path.win32.basename(rule.executable).toLowerCase() !== "winword.exe"
      || !rule.documentRegions?.some((selector) => "scope" in selector && selector.scope === "word.document")) return false;
  let current: NativeNode | undefined = node;
  const chain = [["Document", "_WwG"], ["Pane", "_WwB"], ["Pane", "_WwF"], ["Window", "OpusApp"]];
  for (let index = 0; index < chain.length; ++index) {
    const [type, className] = chain[index]!;
    if (!current || current.controlType !== type || current.className !== className || current.automationId !== ""
        || current.depth !== 3 - index || current.password !== false || (index > 0 && current.redaction)
        || current.missing?.includes("automationId")) return false;
    if (index === 3) return current.parentKey === null;
    current = current.parentKey ? nodes.get(current.parentKey) : undefined;
  }
  return false;
}
