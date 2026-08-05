import { parse, stringify } from "yaml";
import type { MemoryProvenance, MemoryRow, MemoryStatus, RuntimeNamespace } from "../../types.js";
import { kindFromMemory } from "../../storage/repositories.js";
import { detailFromMemory } from "../read-model/memory.js";

export interface MemoryMarkdownFrontMatter {
  id: string;
  kind: string;
  memoryLayer: string;
  status: MemoryStatus;
  title: string;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  provenance?: MemoryProvenance;
  supersession?: {
    supersedesMemoryIds: string[];
    supersededByMemoryId?: string;
    reason?: string;
  };
  audit: {
    source: "memmy-memory";
    editable: ["title", "tags", "body"];
  };
}

export interface ParsedMemoryMarkdown {
  frontMatter: MemoryMarkdownFrontMatter;
  body: string;
}

export function renderMemoryMarkdown(memory: MemoryRow): string {
  const detail = detailFromMemory(memory);
  const frontMatter: MemoryMarkdownFrontMatter = {
    id: memory.id,
    kind: kindFromMemory(memory),
    memoryLayer: memory.memoryLayer,
    status: memory.status,
    title: detail.title,
    tags: memory.tags,
    version: memory.version,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    ...(detail.provenance ? { provenance: detail.provenance } : {}),
    ...(detail.supersession ? { supersession: detail.supersession } : {}),
    audit: {
      source: "memmy-memory",
      editable: ["title", "tags", "body"]
    }
  };
  return `---\n${stringify(frontMatter).trimEnd()}\n---\n# ${detail.title}\n\n${memory.memoryValue.trim()}\n`;
}

export function renderMemoryMarkdownBundle(memories: MemoryRow[]): string {
  return memories.map(renderMemoryMarkdown).join("\n---\n\n");
}

export function parseMemoryMarkdownBundle(markdown: string): ParsedMemoryMarkdown[] {
  const documents = markdown
    .replace(/^\uFEFF/, "")
    .split(/\n---\n(?=\n?---\n|id:|$)/g)
    .map((value) => value.trim())
    .filter(Boolean);
  return documents.map(parseMemoryMarkdown);
}

export function parseMemoryMarkdown(markdown: string): ParsedMemoryMarkdown {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) throw new Error("markdown audit document must contain YAML front matter");
  const parsed = parse(match[1] ?? "") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("markdown audit front matter must be an object");
  }
  const frontMatter = parsed as Partial<MemoryMarkdownFrontMatter>;
  if (typeof frontMatter.id !== "string" || !frontMatter.id.trim()) {
    throw new Error("markdown audit front matter requires id");
  }
  const body = stripTitleHeading(match[2] ?? "");
  return {
    frontMatter: {
      id: frontMatter.id.trim(),
      kind: typeof frontMatter.kind === "string" ? frontMatter.kind : "trace",
      memoryLayer: typeof frontMatter.memoryLayer === "string" ? frontMatter.memoryLayer : "L1",
      status: frontMatter.status ?? "activated",
      title: typeof frontMatter.title === "string" && frontMatter.title.trim()
        ? frontMatter.title.trim()
        : firstBodyLine(body) || frontMatter.id,
      tags: Array.isArray(frontMatter.tags)
        ? frontMatter.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      version: typeof frontMatter.version === "number" ? frontMatter.version : 1,
      createdAt: typeof frontMatter.createdAt === "string" ? frontMatter.createdAt : new Date().toISOString(),
      updatedAt: typeof frontMatter.updatedAt === "string" ? frontMatter.updatedAt : new Date().toISOString(),
      ...(frontMatter.provenance ? { provenance: frontMatter.provenance } : {}),
      ...(frontMatter.supersession ? { supersession: frontMatter.supersession } : {}),
      audit: {
        source: "memmy-memory",
        editable: ["title", "tags", "body"]
      }
    },
    body
  };
}

export function markdownNamespace(frontMatter: MemoryMarkdownFrontMatter): RuntimeNamespace | undefined {
  const provenance = frontMatter.provenance;
  if (!provenance) return undefined;
  return {
    source: provenance.sourceAgent,
    profileId: provenance.profileId ?? "default",
    projectId: provenance.projectId,
    workspaceId: provenance.workspaceId,
    workspacePath: provenance.workspacePath
  };
}

function stripTitleHeading(value: string): string {
  const lines = value.replace(/^\s+/, "").split(/\r?\n/);
  if (lines[0]?.match(/^#\s+/)) lines.shift();
  return lines.join("\n").trim();
}

function firstBodyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}
