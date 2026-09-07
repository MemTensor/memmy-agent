#!/usr/bin/env node

// Derive a machine-facing Workflow Candidate from a human Computer History
// JSONL recording. The user-facing History Markdown remains a separate
// presentation artifact.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRecords, reusableHumanActions } from "./summarize-history.mjs";

function usage() {
  console.log(`Usage:
  node workflows/scripts/extract-workflow-candidate.mjs --file <events.jsonl> --out <candidate.md>

Options:
  --file <path>               human recording JSONL
  --out <path>                candidate Markdown output
  --title <text>              candidate title
  --source-history-id <id>    History id used for linking`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw new Error(`${key} requires a value`);
      return next;
    };
    if (key === "--file") args.file = value();
    else if (key === "--out") args.out = value();
    else if (key === "--title") args.title = value();
    else if (key === "--source-history-id") args.sourceHistoryId = value();
    else if (key === "--help" || key === "-h") args.help = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (args.help) return args;
  if (!args.file || !args.out) throw new Error("--file and --out are required");
  return args;
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

export function renderWorkflowCandidate({ file, records, title, sourceHistoryId }) {
  const events = records.filter((record) => record?.recordType === "human_event");
  const steps = reusableHumanActions(events);
  if (!steps.length) return null;
  const resolvedTitle = title || "Computer History reusable operation candidate";
  const output = [
    "---",
    `title: ${yamlString(resolvedTitle)}`,
    "kind: computer_use_workflow_candidate",
    ...(sourceHistoryId ? [`source_history_id: ${yamlString(sourceHistoryId)}`] : []),
    `source_recording: ${yamlString(file)}`,
    "generated_from: human_operation_events",
    "status: candidate",
    "experience_version: 1",
    "---",
    "",
    `# Workflow Candidate：${resolvedTitle}`,
    "",
    "This is a machine-facing candidate derived from the raw operation event stream. It is not executed automatically; the Agent must generate or select a gated Workflow before using Computer Use.",
    "",
    "## Semantic steps",
    "",
  ];
  steps.forEach((step, index) => output.push(`${index + 1}. ${step}`));
  output.push(
    "",
    "## Source",
    "",
    `- JSONL: \`${file}\``,
    "- Coordinates and exact scroll distances are intentionally excluded.",
    "- Redacted values must be supplied by the current user request or a declared variable.",
    "",
  );
  return output.join("\n");
}

export function run(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return null;
  }
  const { records } = loadRecords(path.resolve(args.file));
  const markdown = renderWorkflowCandidate({
    file: path.resolve(args.file),
    records,
    title: args.title,
    sourceHistoryId: args.sourceHistoryId,
  });
  if (!markdown) {
    console.error("workflow candidate not ready: no reusable semantic steps found");
    return null;
  }
  const out = path.resolve(args.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, markdown, "utf8");
  console.log(`workflow candidate written: ${out}`);
  return { out, markdown };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const result = run();
    if (!result) process.exitCode = 2;
  } catch (error) {
    console.error(`workflow candidate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
