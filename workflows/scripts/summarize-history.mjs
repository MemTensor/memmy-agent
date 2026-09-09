#!/usr/bin/env node
// Convert one Memmy terminal session JSONL into a factual, Codex Computer
// History-style Markdown summary.
//
// This is intentionally session-scoped. It summarizes activity already
// captured by Memmy; it does not monitor unrelated desktop activity.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".memmy", "workspace", "sessions");
const DEFAULT_RECORDINGS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "recordings",
);
const DEFAULT_HISTORY_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "history",
);
const SUMMARY_TEXT_LIMIT = 800;
const EVENT_TEXT_LIMIT = 360;

const APPLICATION_PATTERNS = [
  { id: "com.google.Chrome", pattern: /\b(?:Google )?Chrome\b/i },
  { id: "com.apple.Safari", pattern: /\bSafari\b/i },
  { id: "com.apple.Notes", pattern: /\bNotes\b|备忘录/u },
  { id: "com.apple.TextEdit", pattern: /\bTextEdit\b|文本编辑/u },
  { id: "com.apple.calculator", pattern: /\bCalculator\b|计算器/u },
  { id: "com.apple.finder", pattern: /\bFinder\b|访达/u },
  { id: "com.apple.Preview", pattern: /\bPreview\b|预览/u },
  { id: "com.apple.Spotlight", pattern: /\bSpotlight\b|聚焦搜索/u },
  { id: "com.openai.codex", pattern: /\bCodex\b/i },
  { id: "com.mitchellh.ghostty", pattern: /\bGhostty\b/i },
];

function usage() {
  console.log(`Usage:
  node workflows/scripts/summarize-history.mjs --latest
  node workflows/scripts/summarize-history.mjs --latest-recording
  node workflows/scripts/summarize-history.mjs --session <session-key>
  node workflows/scripts/summarize-history.mjs --file <session.jsonl>

Options:
  --sessions-dir <dir>       session directory (default: ~/.memmy/workspace/sessions)
  --recordings-dir <dir>     human recording directory (default: workflows/recordings)
  --out <path>               output Markdown path (default: workflows/history/...)
  --last <n>                 include only the last n user turns
  --title <text>             override generated title
  --description <text>       override generated description
  --application <bundle-id>  add a known application id; repeatable
  --help                     show this help

With no selector, --latest is used.`);
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function parseArgs(argv) {
  const args = { applications: [], latest: false, last: 0 };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw new Error(`${key} requires a value`);
      return next;
    };
    if (key === "--latest") args.latest = true;
    else if (key === "--latest-recording") args.latestRecording = true;
    else if (key === "--session") args.session = value();
    else if (key === "--file") args.file = value();
    else if (key === "--sessions-dir") args.sessionsDir = value();
    else if (key === "--recordings-dir") args.recordingsDir = value();
    else if (key === "--out") args.out = value();
    else if (key === "--last") args.last = Number(value());
    else if (key === "--title") args.title = value();
    else if (key === "--description") args.description = value();
    else if (key === "--application") args.applications.push(value());
    else if (key === "--help" || key === "-h") args.help = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  const selectors = Number(args.latest) + Number(args.latestRecording)
    + Number(Boolean(args.session)) + Number(Boolean(args.file));
  if (selectors > 1) {
    throw new Error("choose only one of --latest, --latest-recording, --session, or --file");
  }
  if (!Number.isInteger(args.last) || args.last < 0) throw new Error("--last must be a non-negative integer");
  if (selectors === 0) args.latest = true;
  return args;
}

function sessionFilename(sessionKey) {
  const normalized = sessionKey.replace(/^cli:/, "cli_").replaceAll(":", "_");
  return normalized.endsWith(".jsonl") ? normalized : `${normalized}.jsonl`;
}

function latestSessionFile(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) throw new Error(`sessions directory not found: ${sessionsDir}`);
  const candidates = fs.readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".jsonl") && name !== "history.jsonl")
    .map((name) => {
      const file = path.join(sessionsDir, name);
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!candidates.length) throw new Error(`no session JSONL files found in: ${sessionsDir}`);
  return candidates[0].file;
}

function latestHumanRecordingFile(recordingsDir) {
  if (!fs.existsSync(recordingsDir)) throw new Error(`recordings directory not found: ${recordingsDir}`);
  const pending = [recordingsDir];
  const candidates = [];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name === "events.jsonl") {
        candidates.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
      }
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!candidates.length) throw new Error(`no human recording events.jsonl found in: ${recordingsDir}`);
  return candidates[0].file;
}

export function resolveSessionFile(args) {
  const sessionsDir = path.resolve(expandHome(args.sessionsDir ?? DEFAULT_SESSIONS_DIR));
  if (args.file) return path.resolve(expandHome(args.file));
  if (args.session) return path.join(sessionsDir, sessionFilename(args.session));
  if (args.latestRecording) {
    const recordingsDir = path.resolve(expandHome(args.recordingsDir ?? DEFAULT_RECORDINGS_DIR));
    return latestHumanRecordingFile(recordingsDir);
  }
  return latestSessionFile(sessionsDir);
}

export function loadRecords(file) {
  if (!fs.existsSync(file)) throw new Error(`session file not found: ${file}`);
  const records = [];
  const malformedLines = [];
  fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object") records.push(record);
    } catch {
      malformedLines.push(index + 1);
    }
  });
  return { records, malformedLines };
}

function imagePathFromBlock(block) {
  if (!block || typeof block !== "object") return null;
  if (typeof block.meta?.path === "string") return block.meta.path;
  if (typeof block.path === "string") return block.path;
  return null;
}

export function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    if (block.type === "text" && typeof block.text === "string") return block.text;
    const imagePath = imagePathFromBlock(block);
    if (imagePath) return `[image: ${imagePath}]`;
    if (block.type === "image_url") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

function cleanInline(value, max = EVENT_TEXT_LIMIT) {
  const clean = redactSensitive(String(value ?? "")).replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

export function redactSensitive(value) {
  return String(value ?? "")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[image base64 omitted]")
    .replace(/\bBearer\s+[a-z0-9._~+/-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(
      /((?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|password|secret)\s*[:=]\s*)["']?[^\s,"']+["']?/gi,
      "$1[REDACTED]",
    );
}

function yamlString(value) {
  return JSON.stringify(redactSensitive(String(value ?? "")));
}

function formatArguments(value) {
  if (typeof value !== "string") return cleanInline(JSON.stringify(value ?? {}), 260);
  try {
    return cleanInline(JSON.stringify(JSON.parse(value)), 260);
  } catch {
    return cleanInline(value, 260);
  }
}

function recordTimestamp(record) {
  return typeof record?.timestamp === "string" ? record.timestamp : null;
}

export function groupTurns(records) {
  const turns = [];
  let current = null;
  for (const record of records) {
    if (!record?.role) continue;
    if (record.role === "user") {
      current = { user: record, events: [] };
      turns.push(current);
    } else if (current) {
      current.events.push(record);
    }
  }
  return turns;
}

function collectArtifacts(records) {
  const artifacts = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    artifacts.push(candidate);
  };
  for (const record of records) {
    if (Array.isArray(record.content)) {
      for (const block of record.content) add(imagePathFromBlock(block));
    }
    const text = contentToText(record.content);
    for (const match of text.matchAll(/Saved to:\s*([^\n]+)/g)) add(match[1].trim());
    for (const match of text.matchAll(/\[image:\s*([^\]]+)\]/g)) add(match[1].trim());
  }
  return artifacts;
}

function collectToolCounts(records) {
  const counts = new Map();
  for (const record of records) {
    if (record.role !== "assistant" || !Array.isArray(record.tool_calls)) continue;
    for (const call of record.tool_calls) {
      const name = call?.function?.name ?? "unknown_tool";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

function collectApplications(records, explicitApplications) {
  const corpus = records.map((record) => contentToText(record.content)).join("\n");
  const applications = [];
  const seen = new Set();
  const add = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    applications.push(id);
  };
  explicitApplications.forEach(add);
  for (const candidate of APPLICATION_PATTERNS) {
    if (candidate.pattern.test(corpus)) add(candidate.id);
  }
  return applications;
}

function finalAssistantText(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.role !== "assistant") continue;
    const text = contentToText(record.content).trim();
    if (text) return text;
  }
  return "";
}

function sessionStatus(records, finalText) {
  const corpus = records.map((record) => contentToText(record.content)).join("\n");
  if (/task cancelled|cancell?ed|已取消|用户中断/i.test(corpus)) return "cancelled";
  if (records.some((record) => record.finish_reason === "error" || record.error)) return "error";
  return finalText ? "completed" : "incomplete";
}

function metadataFromRecords(records) {
  return records.find((record) => record.recordType === "metadata") ?? null;
}

function timeRange(records, metadata) {
  const timestamps = records.map(recordTimestamp).filter(Boolean).sort();
  return {
    start: timestamps[0] ?? metadata?.createdAt ?? null,
    end: timestamps.at(-1) ?? metadata?.updatedAt ?? null,
  };
}

function sessionId(metadata, file) {
  return metadata?.key ?? path.basename(file, ".jsonl");
}

function modelDetails(metadata, records) {
  const userWithModel = records.find((record) => record.role === "user" && record.model);
  return {
    preset: metadata?.metadata?.modelPreset ?? userWithModel?.model_preset ?? null,
    provider: metadata?.metadata?.modelSelection?.provider ?? userWithModel?.model_provider ?? null,
    model: metadata?.metadata?.modelSelection?.model ?? userWithModel?.model ?? null,
  };
}

function defaultTitle(turns, file) {
  const instruction = contentToText(turns[0]?.user?.content);
  return cleanInline(instruction || path.basename(file, ".jsonl"), 80);
}

function renderEvent(record) {
  const prefix = recordTimestamp(record) ? `- ${record.timestamp} — ` : "- ";
  if (record.role === "assistant" && Array.isArray(record.tool_calls) && record.tool_calls.length) {
    return record.tool_calls.map((call) => {
      const name = call?.function?.name ?? "unknown_tool";
      const args = formatArguments(call?.function?.arguments ?? {});
      return `${prefix}Tool call \`${name}\` with \`${args}\``;
    });
  }
  if (record.role === "tool") {
    const name = record.name ?? "tool";
    const result = cleanInline(contentToText(record.content), EVENT_TEXT_LIMIT) || "(empty result)";
    return [`${prefix}Tool result \`${name}\`: ${result}`];
  }
  if (record.role === "assistant") {
    const text = cleanInline(contentToText(record.content), EVENT_TEXT_LIMIT);
    return text ? [`${prefix}Agent: ${text}`] : [];
  }
  return [];
}

function isHumanHistory(records) {
  return records.some((record) => record.recordType === "human_history_metadata");
}

function humanApplications(records, explicitApplications) {
  const applications = [];
  const seen = new Set();
  const add = (id) => {
    if (!id || id === "unknown" || seen.has(id)) return;
    seen.add(id);
    applications.push(id);
  };
  explicitApplications.forEach(add);
  for (const record of records) add(record.application?.bundleId);
  return applications;
}

function humanArtifacts(records) {
  return records.map((record) => record.screenshot).filter((value) => typeof value === "string");
}

function accessibilityNode(raw) {
  if (!raw || typeof raw !== "object") return null;
  const role = cleanInline(raw.role, 80);
  const subrole = cleanInline(raw.subrole, 80);
  const label = [raw.title, raw.description, raw.value, raw.help, raw.identifier]
    .map((value) => cleanInline(value, 180))
    .find(Boolean);
  if (!role && !subrole && !label) return null;
  return {
    role,
    subrole,
    label,
    text: [subrole || role, label ? JSON.stringify(label) : ""].filter(Boolean).join(" "),
  };
}

const INTERACTIVE_ACCESSIBILITY_ROLES = new Set([
  "AXButton", "AXRadioButton", "AXCheckBox", "AXPopUpButton", "AXTextField",
  "AXTextArea", "AXComboBox", "AXLink", "AXMenuItem", "AXTabButton", "AXSlider",
  "AXIncrementor", "AXSearchField",
]);

function isInteractiveAccessibilityNode(node) {
  return Boolean(node && INTERACTIVE_ACCESSIBILITY_ROLES.has(node.role || node.subrole));
}

function semanticSectionAnchor(nodes, target) {
  const candidates = nodes.filter((node) => node?.label && node.text !== target?.text);
  return candidates.find((node) => node.subrole === "AXFieldset")
    ?? candidates.find((node) => ["AXGroup", "AXToolbar", "AXDialog"].includes(node.role))
    ?? null;
}

function semanticAccessibilityTarget(details) {
  const accessibility = details?.accessibility;
  if (!accessibility || typeof accessibility !== "object") return null;
  const self = accessibilityNode(accessibility);
  const focused = accessibilityNode(accessibility.focused);
  const descendants = (Array.isArray(accessibility.descendants) ? accessibility.descendants : [])
    .map(accessibilityNode)
    .filter(Boolean);
  const ancestors = (Array.isArray(accessibility.ancestors) ? accessibility.ancestors : [])
    .map(accessibilityNode)
    .filter(Boolean);
  // The post-click focused control is the most reliable identity of what the
  // click actually activated; interactive descendants are more useful than
  // anonymous web containers or short leaf text such as "GB".
  const target = [
    focused && isInteractiveAccessibilityNode(focused) && focused.label ? focused : null,
    descendants.find((node) => isInteractiveAccessibilityNode(node) && node.label),
    self && isInteractiveAccessibilityNode(self) && self.label ? self : null,
    focused?.label ? focused : null,
    self?.label ? self : null,
    descendants.find((node) => node.label),
    self,
  ].find(Boolean);
  if (!target) return null;
  const section = semanticSectionAnchor(ancestors, target);
  return section ? `${target.text} inside ${section.text}` : target.text;
}

function clickHasSemanticLabel(details) {
  const accessibility = details?.accessibility;
  if (!accessibility || typeof accessibility !== "object") return false;
  const nodes = [
    accessibility,
    accessibility.focused,
    ...(Array.isArray(accessibility.descendants) ? accessibility.descendants : []),
    ...(Array.isArray(accessibility.ancestors) ? accessibility.ancestors : []),
  ];
  return nodes.some((node) => accessibilityNode(node)?.label);
}

function reusableHumanAction(record, { navigationHint = "" } = {}) {
  const application = record.application?.name ?? record.application?.bundleId ?? "unknown application";
  const bundleId = record.application?.bundleId ?? "unknown";
  const details = record.details ?? {};
  if (record.eventType === "application_changed") {
    return `Activate ${application} (\`${bundleId}\`) and verify its main content window is visible.`;
  }
  if (record.eventType === "mouse_click") {
    const target = clickHasSemanticLabel(details) ? semanticAccessibilityTarget(details) : null;
    const navigation = navigationHint ? `, ${navigationHint}` : "";
    return target
      ? `In ${application} (\`${bundleId}\`)${navigation}, locate ${target} from the current Accessibility state, activate it once, then verify the resulting UI state before continuing.`
      : `In ${application} (\`${bundleId}\`), an element was activated but its semantic label was unavailable; rely on the surrounding page context to infer the intent, and stop during replay instead of falling back to the recorded coordinates.`;
  }
  if (record.eventType === "page_context") {
    const url = cleanInline(details.url, 500);
    if (!url) return null;
    const title = cleanInline(details.title, 160);
    return `Confirm the front browser page in ${application} (\`${bundleId}\`) is now ${url}${title ? ` (“${title}”)` : ""} before continuing; the URL path encodes the state reached by the previous action.`;
  }
  if (record.eventType === "scroll") {
    const direction = details.direction && details.direction !== "none" ? details.direction : "within the page";
    return `In ${application} (\`${bundleId}\`), move ${direction} only far enough to reveal the next recorded semantic target; observe again after at most one viewport.`;
  }
  if (record.eventType === "text_input") {
    return details.redacted
      ? `Text was entered in ${application} (\`${bundleId}\`) but was intentionally redacted; require a current task variable or stop instead of guessing it.`
      : `Enter ${cleanInline(JSON.stringify(details.text ?? ""), 240)} in the matching semantic field in ${application} (\`${bundleId}\`), then verify the visible value.`;
  }
  if (record.eventType === "key_press") {
    const keys = (details.keys ?? []).map((key) => `\`${cleanInline(key, 80)}\``).join(", ");
    return `In ${application} (\`${bundleId}\`), send ${keys || "the recorded semantic key action"}, then verify its effect.`;
  }
  return null;
}

function compressedScrollHint(scrolls) {
  const directions = [...new Set(scrolls
    .map((record) => record.details?.direction)
    .filter((direction) => direction && direction !== "none"))];
  const direction = directions.length === 1 ? directions[0] : "within the page";
  return `after moving ${direction} only as needed to reveal the next semantic target`;
}

export function reusableHumanActions(events) {
  const actions = [];
  let pendingScrolls = [];
  const flushPendingScrolls = () => {
    if (!pendingScrolls.length) return;
    const action = reusableHumanAction(pendingScrolls.at(-1));
    if (action) actions.push(action);
    pendingScrolls = [];
  };
  for (const event of events) {
    if (event.eventType === "scroll") {
      pendingScrolls.push(event);
      continue;
    }
    if (event.eventType === "mouse_click") {
      const sameApplication = !pendingScrolls.length
        || pendingScrolls.every((scroll) => (
          scroll.application?.bundleId === event.application?.bundleId
        ));
      if (!sameApplication) flushPendingScrolls();
      const action = reusableHumanAction(event, {
        navigationHint: pendingScrolls.length ? compressedScrollHint(pendingScrolls) : "",
      });
      if (action) actions.push(action);
      pendingScrolls = [];
      continue;
    }
    const action = reusableHumanAction(event);
    if (action) actions.push(action);
  }
  flushPendingScrolls();
  return actions;
}

function isGenericHumanTitle(value) {
  return !value
    || /^(?:Computer History demonstration|Human-operated macOS workflow)$/iu.test(String(value).trim());
}

function derivedHumanTitle(events, fallback) {
  const applications = events
    .map((event) => event.application?.name ?? event.application?.bundleId ?? "")
    .filter(Boolean);
  const app = applications[0] || "Computer History";
  const pageUrls = events
    .filter((event) => event.eventType === "page_context")
    .map((event) => event.details?.url)
    .filter((url) => typeof url === "string" && url);
  const lastUrl = pageUrls.at(-1) ?? "";
  let host = "";
  try {
    host = new URL(lastUrl).hostname.replace(/^www\./iu, "");
  } catch {
    // Keep the application-only title when the recording has no valid URL.
  }
  const textInput = events.find((event) => (
    event.eventType === "text_input"
    && event.details?.redacted === false
    && typeof event.details?.text === "string"
    && event.details.text.trim()
  ));
  const query = textInput?.details?.text?.replace(/\s+/gu, " ").trim();
  const clickLabels = events
    .filter((event) => event.eventType === "mouse_click")
    .map((event) => semanticAccessibilityTarget(event.details) ?? "")
    .join(" ");
  if (/amazon\./iu.test(host) && query) {
    return `${host} 搜索 ${cleanInline(query, 48)}${/add to cart|加入购物车|add to bag/iu.test(clickLabels) ? " 并加入购物车" : ""}`;
  }
  if (/notes|备忘录/iu.test(app)) return "在备忘录记录工作内容";
  if (/notion/iu.test(host) || /notion/iu.test(app)) return "在 Notion 更新工作记录";
  if (host) return `${host} 页面操作记录`;
  return fallback || `${app} 操作记录`;
}


export function renderHumanSummary({
  file,
  records,
  malformedLines = [],
  title,
  description,
  explicitApplications = [],
}) {
  const metadata = records.find((record) => record.recordType === "human_history_metadata") ?? {};
  const events = records.filter((record) => record.recordType === "human_event");
  if (!events.length) throw new Error("no human operation events found in the selected recording");
  const stopped = events.some((record) => record.eventType === "recording_stopped");
  const status = stopped ? "completed" : "incomplete";
  const applications = humanApplications(events, explicitApplications);
  const artifacts = humanArtifacts(events);
  const clickEvents = events.filter((record) => record.eventType === "mouse_click");
  const semanticClickCount = clickEvents.filter((record) => clickHasSemanticLabel(record.details)).length;
  const finalPageContext = [...events].reverse().find((record) => (
    record.eventType === "page_context" && record.details?.url
  ));
  const eventCounts = new Map();
  for (const event of events) {
    eventCounts.set(event.eventType, (eventCounts.get(event.eventType) ?? 0) + 1);
  }
  const timestamps = events.map(recordTimestamp).filter(Boolean).sort();
  const initialTitle = title || metadata.title || "Human-operated macOS workflow";
  const resolvedTitle = isGenericHumanTitle(initialTitle)
    ? derivedHumanTitle(events, initialTitle)
    : initialTitle;
  const resolvedDescription = description || (
    `用户在「${cleanInline(resolvedTitle, SUMMARY_TEXT_LIMIT)}」中完成了一组电脑操作，`
    + "已整理为可读的行为记忆。"
  );
  const recordingId = metadata.recordingId ?? path.basename(path.dirname(file));

  const output = [
    "---",
    `title: ${yamlString(resolvedTitle)}`,
    `description: ${yamlString(resolvedDescription)}`,
    `applications: [${applications.map(yamlString).join(", ")}]`,
    `source_session: ${yamlString(recordingId)}`,
    `source_type: human_computer_history`,
    "experience_version: 1",
    ...(metadata.contextUrl ? [`start_url: ${yamlString(cleanInline(metadata.contextUrl, 2048))}`] : []),
    `status: ${status}`,
    // Marks the summary as not yet written. The body below is a placeholder;
    // the model replaces it, and only then does the entry become presentable.
    "summary_state: pending",
    "---",
    "",
    "## Memory summary",
    "",
    "（尚未生成）",
  ];
  if (malformedLines.length) {
    output.push("", `<!-- skipped malformed JSONL lines: ${malformedLines.join(", ")} -->`);
  }

  output.push("", "## Citations", "", `- ${file}`);
  for (const artifact of artifacts) output.push(`- ${artifact}`);
  output.push("");
  return output.join("\n");
}

export function renderSummary({
  file,
  records,
  malformedLines = [],
  last = 0,
  title,
  description,
  explicitApplications = [],
}) {
  if (isHumanHistory(records)) {
    return renderHumanSummary({
      file,
      records,
      malformedLines,
      title,
      description,
      explicitApplications,
    });
  }
  const metadata = metadataFromRecords(records);
  const allTurns = groupTurns(records);
  const turns = last > 0 ? allTurns.slice(-last) : allTurns;
  if (!turns.length) throw new Error("no user turns found in the selected session");

  const firstSelectedUser = records.indexOf(turns[0].user);
  const selectedRecords = records.filter((record, index) => (
    record.recordType === "metadata" || index >= firstSelectedUser
  ));
  const applications = collectApplications(selectedRecords, explicitApplications);
  const artifacts = collectArtifacts(selectedRecords);
  const toolCounts = collectToolCounts(selectedRecords);
  const toolCallTotal = [...toolCounts.values()].reduce((sum, count) => sum + count, 0);
  const finalText = finalAssistantText(selectedRecords);
  const status = sessionStatus(selectedRecords, finalText);
  const times = timeRange(selectedRecords, metadata);
  const model = modelDetails(metadata, selectedRecords);
  const resolvedTitle = title || defaultTitle(turns, file);
  const firstRequest = cleanInline(contentToText(turns[0].user.content), SUMMARY_TEXT_LIMIT);
  const resolvedDescription = description || (
    `Memmy session summary with ${turns.length} user turn(s), ${toolCallTotal} tool call(s), `
    + `${artifacts.length} captured image artifact(s), and status ${status}.`
  );

  const output = [
    "---",
    `title: ${yamlString(resolvedTitle)}`,
    `description: ${yamlString(resolvedDescription)}`,
    `applications: [${applications.map(yamlString).join(", ")}]`,
    `source_session: ${yamlString(sessionId(metadata, file))}`,
    `status: ${status}`,
    "---",
    "",
    "## Memory summary",
    "",
    `用户请求：${firstRequest}`,
    "",
    `本次选定范围包含 ${turns.length} 个用户轮次、${toolCallTotal} 次工具调用和 ${artifacts.length} 个图片产物。会话状态为 \`${status}\`。`,
    "",
    "### Relevant prior context",
    "",
  ];

  const omittedTurnCount = allTurns.length - turns.length;
  if (omittedTurnCount > 0) {
    output.push(`- 由于使用了 \`--last ${last}\`，省略了同一会话更早的 ${omittedTurnCount} 个用户轮次。`);
  } else if (turns.length > 1) {
    for (const turn of turns.slice(0, -1)) {
      output.push(`- ${cleanInline(contentToText(turn.user.content), 240)}`);
    }
  } else {
    output.push("- 选定范围内没有更早的用户轮次。");
  }

  output.push(
    "",
    "### Important non-obvious context",
    "",
    `- Source session: \`${sessionId(metadata, file)}\``,
    `- Source file: \`${file}\``,
    `- Time range: ${times.start ?? "unknown"} → ${times.end ?? "unknown"}`,
    `- Model: ${model.provider ?? "unknown"} / ${model.model ?? "unknown"}${model.preset ? ` (preset: ${model.preset})` : ""}`,
    `- Tool calls: ${toolCounts.size ? [...toolCounts].map(([name, count]) => `${name} × ${count}`).join(", ") : "none"}`,
    `- Applications: ${applications.length ? applications.join(", ") : "not established from session evidence"}`,
  );
  if (malformedLines.length) output.push(`- Skipped malformed JSONL lines: ${malformedLines.join(", ")}`);

  output.push("", "## Recording summary", "");
  turns.forEach((turn, index) => {
    const request = cleanInline(contentToText(turn.user.content), 180);
    output.push(`### Turn ${index + 1}: ${request}`, "", `**User request:** ${request}`, "");
    const renderedEvents = turn.events.flatMap(renderEvent);
    if (renderedEvents.length) output.push(...renderedEvents);
    else output.push("- No assistant or tool activity was recorded for this turn.");
    output.push("");
  });

  output.push(
    "## End State",
    "",
    `- Session status: \`${status}\``,
    `- Final assistant response: ${finalText ? cleanInline(finalText, SUMMARY_TEXT_LIMIT) : "not recorded"}`,
    `- Captured image artifacts: ${artifacts.length}`,
  );
  for (const artifact of artifacts) output.push(`  - \`${artifact}\``);

  output.push("", "## Citations", "", `- ${file}`);
  for (const artifact of artifacts) output.push(`- ${artifact}`);
  output.push("");
  return output.join("\n");
}

function defaultOutputPath(file, records) {
  const metadata = metadataFromRecords(records);
  const key = sessionId(metadata, file).replace(/[^a-zA-Z0-9_-]+/g, "_");
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
  return path.join(DEFAULT_HISTORY_DIR, `${stamp}-${key}-memory-summary.md`);
}

export function run(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return null;
  }
  const file = resolveSessionFile(args);
  const { records, malformedLines } = loadRecords(file);
  const markdown = renderSummary({
    file,
    records,
    malformedLines,
    last: args.last,
    title: args.title,
    description: args.description,
    explicitApplications: args.applications,
  });
  const outPath = path.resolve(expandHome(args.out ?? defaultOutputPath(file, records)));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown, "utf8");
  console.log(`history summary written: ${outPath}`);
  console.log(`source session: ${file}`);
  return { outPath, file };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    run();
  } catch (error) {
    console.error(`history summary failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
