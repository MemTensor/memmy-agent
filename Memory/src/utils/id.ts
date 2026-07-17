import { createHash, randomBytes } from "node:crypto";

const STABLE_STRINGIFY_MAX_DEPTH = 40;
const STABLE_STRINGIFY_MAX_NODES = 5_000;
const STABLE_STRINGIFY_MAX_STRING_LENGTH = 20_000;
const STABLE_STRINGIFY_MAX_ARRAY_ITEMS = 1_000;
const STABLE_STRINGIFY_MAX_OBJECT_KEYS = 1_000;

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value, {
    depth: 0,
    budget: { nodes: 0 },
    seen: new WeakSet<object>()
  }));
}

interface SortJsonState {
  depth: number;
  budget: {
    nodes: number;
  };
  seen: WeakSet<object>;
}

function sortJson(value: unknown, state: SortJsonState): unknown {
  if (typeof value === "string") {
    return limitStableString(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return null;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  state.budget.nodes += 1;
  if (state.budget.nodes > STABLE_STRINGIFY_MAX_NODES) {
    return "[stable-stringify:node-limit]";
  }
  if (state.depth >= STABLE_STRINGIFY_MAX_DEPTH) {
    return Array.isArray(value) ? "[stable-stringify:array-depth-limit]" : "[stable-stringify:object-depth-limit]";
  }
  if (state.seen.has(value)) {
    return "[stable-stringify:circular]";
  }

  state.seen.add(value);
  const nextState = {
    ...state,
    depth: state.depth + 1
  };

  try {
    if (Array.isArray(value)) {
      const out = value.slice(0, STABLE_STRINGIFY_MAX_ARRAY_ITEMS).map((item) => sortJson(item, nextState));
      if (value.length > STABLE_STRINGIFY_MAX_ARRAY_ITEMS) {
        out.push(`[stable-stringify:array-truncated:${value.length - STABLE_STRINGIFY_MAX_ARRAY_ITEMS}]`);
      }
      return out;
    }

    const keys = Object.keys(value).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys.slice(0, STABLE_STRINGIFY_MAX_OBJECT_KEYS)) {
      out[key] = sortJson((value as Record<string, unknown>)[key], nextState);
    }
    if (keys.length > STABLE_STRINGIFY_MAX_OBJECT_KEYS) {
      out["[stable-stringify:object-truncated]"] = keys.length - STABLE_STRINGIFY_MAX_OBJECT_KEYS;
    }
    return out;
  } finally {
    state.seen.delete(value);
  }
}

function limitStableString(value: string): string {
  if (value.length <= STABLE_STRINGIFY_MAX_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, STABLE_STRINGIFY_MAX_STRING_LENGTH)}[stable-stringify:string-truncated:${value.length - STABLE_STRINGIFY_MAX_STRING_LENGTH}]`;
}
