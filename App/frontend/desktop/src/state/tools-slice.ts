/** Tools slice module. */
import { deriveIntegrationState, type IntegrationConnection } from "../integrations/connection-state.js";
import type { IntegrationCategoryTab, IntegrationMeta, IntegrationSurface } from "../integrations/integration-meta.js";

/** Type definition for tools modal state. */
export type ToolsModalState = { kind: "closed" } | { kind: IntegrationSurface; slug: string };

/** Contract for tools state. */
export interface ToolsState {
  status: "idle" | "loading" | "ready" | "error";
  connections: IntegrationConnection[];
  modal: ToolsModalState;
  loadError: string | null;
}

/** Type definition for tools action. */
export type ToolsAction =
  | { type: "tools/loadStart" }
  | { type: "tools/loadSuccess"; connections: IntegrationConnection[] }
  | { type: "tools/loadFailure"; message: string }
  | { type: "tools/openToolModal"; surface: IntegrationSurface; slug: string }
  | { type: "tools/closeModal" }
  | { type: "tools/connectionsUpdated"; connections: IntegrationConnection[] }
  | { type: "tools/connectionFailure"; message: string };

export const initialToolsState: ToolsState = {
  status: "idle",
  connections: [],
  modal: { kind: "closed" },
  loadError: null
};

/** Handles tools reducer. */
export function toolsReducer(state: ToolsState = initialToolsState, action: ToolsAction): ToolsState {
  switch (action.type) {
    case "tools/loadStart":
      return { ...state, status: "loading", loadError: null };
    case "tools/loadSuccess":
      return {
        ...state,
        status: "ready",
        connections: action.connections,
        loadError: null
      };
    case "tools/loadFailure":
      return { ...state, status: "error", loadError: action.message };
    case "tools/openToolModal":
      return { ...state, modal: { kind: action.surface, slug: action.slug } };
    case "tools/closeModal":
      return { ...state, modal: { kind: "closed" } };
    case "tools/connectionsUpdated":
      return { ...state, status: "ready", connections: action.connections, loadError: null };
    case "tools/connectionFailure":
      return { ...state, loadError: action.message };
    default:
      return state;
  }
}

/** Handles select connection for integration. */
export function selectConnectionForIntegration(state: ToolsState, integration: Pick<IntegrationMeta, "slug" | "surface">): IntegrationConnection | undefined {
  return state.connections.find(
    (connection) => connection.toolkit === integration.slug && normalizeConnectionSurface(connection) === integration.surface
  );
}

/** Handles select visible integrations. */
export function selectVisibleIntegrations(
  integrations: IntegrationMeta[],
  search: string,
  category: IntegrationCategoryTab | string
): IntegrationMeta[] {
  const keyword = search.trim().toLowerCase();

  return integrations.filter((item) => {
    const matchSearch = !keyword || item.name.toLowerCase().includes(keyword) || item.slug.toLowerCase().includes(keyword);
    const matchCategory = category === "All" || item.category === category;

    return matchSearch && matchCategory;
  });
}

/** Handles select status prioritized integrations. */
export function selectStatusPrioritizedIntegrations(integrations: IntegrationMeta[], state: ToolsState): IntegrationMeta[] {
  const indexed = integrations.map((item, index) => ({
    item,
    index,
    hasStatus: deriveIntegrationState(selectConnectionForIntegration(state, item)) !== "disconnected"
  }));

  return indexed
    .sort((left, right) => {
      if (left.hasStatus !== right.hasStatus) {
        return left.hasStatus ? -1 : 1;
      }

      return left.index - right.index;
    })
    .map((entry) => entry.item);
}

/** Normalizes normalize connection surface. */
function normalizeConnectionSurface(connection: IntegrationConnection): IntegrationSurface {
  return connection.surface ?? "integration";
}
