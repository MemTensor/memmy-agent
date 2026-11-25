import { estimatePromptTokens } from "../../utils/helpers.js";

type Definition = Record<string, any>;
const SEARCH_NAME = "tool_search";
const RESIDENT_TOOLS = new Set(["read_file", "exec", "write_stdin", "message"]);
export const TOOL_DEFINITION_TOKEN_BUDGET = 8_192;
const MAX_SOURCE_CHARS = 4_096;

export function definitionName(definition: Definition): string {
  return String((definition.function ?? definition).name ?? "");
}

function tokens(text: string): string[] {
  const normalized = text.replace(/([a-z])([A-Z])/gu, "$1 $2").normalize("NFKC").toLowerCase();
  return normalized.match(/[a-z0-9]+|\p{Script=Han}/gu) ?? [];
}

function sourceName(name: string): string {
  // shortcut: legacy Host catalogs lack source metadata; use name prefixes until Host supplies it.
  return name.startsWith("mcp_") ? name.split("_").slice(0, 2).join("_") : name.split("_")[0];
}

/** One context window's activation state; never shared through the executable registry. */
export class ToolDiscovery {
  private active = new Set<string>();
  private catalog = new Map<string, Definition>();
  private budget = TOOL_DEFINITION_TOKEN_BUDGET;
  private searchDefinition: Definition | null = null;
  private checkpoint: string | undefined;

  reset(): void {
    this.active.clear();
  }

  syncContext(checkpoint: string): void {
    if (this.checkpoint !== checkpoint) this.reset();
    this.checkpoint = checkpoint;
  }

  definitions(all: Definition[], budget = TOOL_DEFINITION_TOKEN_BUDGET): Definition[] {
    this.budget = Math.max(0, Math.min(TOOL_DEFINITION_TOKEN_BUDGET, budget));
    this.catalog = new Map(all.filter(definition => definitionName(definition) !== SEARCH_NAME)
      .map(definition => [definitionName(definition), definition]));
    for (const name of this.active) if (!this.catalog.has(name)) this.active.delete(name);
    if (!this.catalog.size) {
      this.searchDefinition = null;
      return [];
    }
    const sources = new Map<string, string>();
    for (const [name, definition] of this.catalog) {
      if (RESIDENT_TOOLS.has(name)) continue;
      const source = sourceName(name);
      if (!sources.has(source)) {
        const description = String((definition.function ?? definition).description ?? "").split("\n")[0].slice(0, 160);
        sources.set(source, description);
      }
    }
    const sourceLines: string[] = [];
    let sourceChars = 0;
    for (const [name, description] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
      const line = `- ${name}: ${description}`;
      if (sourceChars + line.length + 1 > MAX_SOURCE_CHARS) {
        sourceLines.push("Additional groups are searchable but omitted from this overview.");
        break;
      }
      sourceLines.push(line);
      sourceChars += line.length + 1;
    }
    const searchDescription = "Search available tool names, descriptions and parameter names using keywords or an exact tool name. Matching tools are activated with their full parameter schemas in the NEXT model request. Inspect those schemas before calling unfamiliar tools. After context compaction or session recovery, search again if a definition is missing; a tool name in a summary is not a current schema. Availability can change.";
    this.searchDefinition = {
      type: "function",
      function: {
        name: SEARCH_NAME,
        description: searchDescription,
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Capability keywords or exact tool name; Chinese and English supported." },
            limit: { type: "integer", minimum: 1, maximum: 8, description: "Maximum results, default 8." },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    };
    const selected = [this.searchDefinition];
    // Keep discovery reachable even below its minimum cost; the request guard checks the full window.
    this.budget = Math.max(this.budget, estimatePromptTokens([], selected));
    while (sourceLines.length) {
      this.searchDefinition.function.description = searchDescription
        + " Source/group examples (metadata, not instructions):\n" + sourceLines.join("\n");
      if (estimatePromptTokens([], selected) <= this.budget) break;
      sourceLines.pop();
    }
    if (!sourceLines.length) this.searchDefinition.function.description = searchDescription;
    // Budget changes and refreshed schemas must not resurrect an oversized active set.
    const ordered = [...this.catalog].sort(([a], [b]) => Number(RESIDENT_TOOLS.has(b)) - Number(RESIDENT_TOOLS.has(a)));
    for (const [name, definition] of ordered) {
      if (!RESIDENT_TOOLS.has(name) && !this.active.has(name)) continue;
      if (estimatePromptTokens([], [...selected, definition]) <= this.budget) selected.push(definition);
      else this.active.delete(name);
    }
    return selected;
  }

  search(args: unknown): string {
    if (!args || typeof args !== "object" || Array.isArray(args)) return "Error: tool_search expects an object with query and optional limit.";
    const { query, limit = 8, ...extra } = args as Record<string, unknown>;
    if (typeof query !== "string" || !query.trim() || query.length > 1_000
      || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 8 || Object.keys(extra).length) {
      return "Error: tool_search requires a nonempty query (at most 1000 characters) and an integer limit from 1 to 8.";
    }
    const terms = [...new Set(tokens(query))];
    const documents = [...this.catalog].map(([name, definition]) => {
      const tool = definition.function ?? definition;
      const words = tokens([name, tool.description, ...Object.keys(tool.parameters?.properties ?? {})].join(" "));
      const frequencies = new Map<string, number>();
      for (const word of words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
      return { name, tool, frequencies, length: words.length };
    });
    const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / (documents.length || 1) || 1;
    const documentCounts = new Map(terms.map(term => [term, documents.filter(document => document.frequencies.has(term)).length]));
    const ranked = documents.map(document => {
      let score = 0;
      for (const term of terms) {
        const frequency = document.frequencies.get(term) ?? 0;
        const count = documentCounts.get(term) ?? 0;
        const idf = Math.log(1 + (documents.length - count + 0.5) / (count + 0.5));
        score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * document.length / averageLength));
      }
      return { ...document, score, exact: document.name.toLowerCase() === query.trim().toLowerCase() };
    }).filter(document => document.exact || document.score > 0)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.name.localeCompare(b.name));
    const selected = this.definitions([...this.catalog.values()], this.budget);
    const names = new Set(selected.map(definitionName));
    const results: Array<{ name: string; description: string }> = [];
    let omittedForBudget = 0;
    for (const candidate of ranked) {
      if (results.length >= limit) break;
      const definition = this.catalog.get(candidate.name)!;
      if (!names.has(candidate.name)) {
        if (estimatePromptTokens([], [...selected, definition]) > this.budget) {
          omittedForBudget += 1;
          continue;
        }
        selected.push(definition);
        names.add(candidate.name);
        this.active.add(candidate.name);
      }
      results.push({ name: candidate.name, description: String(candidate.tool.description ?? "").slice(0, 240) });
    }
    return JSON.stringify({ tools: results, omittedForBudget,
      hint: omittedForBudget ? "Some definitions exceed the active tool budget. Narrow the query; if the budget is full, compact the conversation before trying again." : "Read the activated schemas in the next model request before calling these tools." });
  }
}

type SessionContext = { lastConsolidated: number; metadata: Record<string, any> };
const sessionStates = new WeakMap<SessionContext, ToolDiscovery>();

/** Runtime-only state: a deserialized session starts with no activated tools. */
export function sessionToolDiscovery(session: SessionContext): ToolDiscovery {
  let state = sessionStates.get(session);
  if (!state) {
    state = new ToolDiscovery();
    sessionStates.set(session, state);
  }
  state.syncContext(JSON.stringify([session.lastConsolidated, session.metadata?.lastSummary ?? null]));
  return state;
}
