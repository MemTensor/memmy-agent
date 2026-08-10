export type MemoryReferencePage = "memories" | "tasks" | "policies" | "world-model" | "skills";

export interface MemoryReferenceOpenRequest {
  id: string;
  requestId: number;
}

export type OpenMemoryReference = (id: string, fallbackPage: MemoryReferencePage) => void;

export function resolveMemoryReferencePage(id: string, fallbackPage: MemoryReferencePage): MemoryReferencePage {
  const localId = id.split("::").at(-1)?.toLowerCase() ?? id.toLowerCase();

  if (/^(?:memory[-_])?episode[-_]/.test(localId)) return "tasks";
  if (/^(?:memory[-_])?(?:trace|span)[-_]/.test(localId)) return "memories";
  if (/^(?:memory[-_])?policy[-_]/.test(localId)) return "policies";
  if (/^(?:memory[-_])?(?:world|world_model)[-_]/.test(localId)) return "world-model";
  if (/^(?:memory[-_])?skill[-_]/.test(localId)) return "skills";

  return fallbackPage;
}

export function MemoryReferenceTags(props: {
  ids: string[];
  fallbackPage: MemoryReferencePage;
  onOpen: OpenMemoryReference;
}) {
  const ids = [...new Set(props.ids.filter(Boolean))];

  return (
    <div className="memory-policy-id-list">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          className="memory-policy-id memory-policy-id--link"
          aria-label={id}
          title={id}
          onClick={() => props.onOpen(id, props.fallbackPage)}
        >
          {compactMemoryReferenceId(id)}
        </button>
      ))}
    </div>
  );
}

function compactMemoryReferenceId(id: string): string {
  const value = id.split("::").at(-1) ?? id;
  return value.length > 22 ? `${value.slice(0, 18)}...` : value;
}
