import type { ComposerContextReference } from "../state/agent-composer-state.js";

export const MEMMY_COMPOSER_REFERENCE_MIME = "application/x-memmy-composer-reference+json";

export function mergeComposerContextReferences(
  current: ComposerContextReference[],
  incoming: ComposerContextReference[]
): ComposerContextReference[] {
  const next = [...current];
  for (const reference of incoming) {
    if (!next.some((item) => item.kind === reference.kind && item.id === reference.id)) {
      next.push(reference);
    }
  }
  return next;
}

export function writeComposerReferenceDrag(
  dataTransfer: DataTransfer,
  reference: ComposerContextReference
): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(MEMMY_COMPOSER_REFERENCE_MIME, JSON.stringify(reference));
  dataTransfer.setData("text/plain", reference.label);
}

export function readComposerReferenceDrag(dataTransfer: DataTransfer): ComposerContextReference | null {
  const payload = dataTransfer.getData(MEMMY_COMPOSER_REFERENCE_MIME);
  if (!payload) return null;
  try {
    const value = JSON.parse(payload) as Partial<ComposerContextReference>;
    if (
      (value.kind === "kb" || value.kind === "path")
      && typeof value.id === "string"
      && value.id.length > 0
      && typeof value.label === "string"
      && value.label.length > 0
    ) {
      return { kind: value.kind, id: value.id, label: value.label };
    }
  } catch {
    return null;
  }
  return null;
}

export function dataTransferHasComposerReference(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(MEMMY_COMPOSER_REFERENCE_MIME);
}
