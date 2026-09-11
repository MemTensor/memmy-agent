import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "summarize-history.mjs");

function writeFixture(dir, name, records) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return file;
}

test("writes a Computer History-style summary from a computer-use session", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-history-test-"));
  const screenshot = path.join(dir, "screen.jpg");
  const session = writeFixture(dir, "cli_demo.jsonl", [
    {
      recordType: "metadata",
      key: "cli:demo",
      createdAt: "2026-08-28T01:00:00.000Z",
      updatedAt: "2026-08-28T01:00:03.000Z",
      metadata: {
        modelPreset: "computer-use-fast",
        modelSelection: { provider: "openai", model: "gpt-5.6-terra" },
      },
    },
    {
      role: "user",
      content: "打开 Google Chrome 并访问 apple.com",
      timestamp: "2026-08-28T01:00:01.000Z",
    },
    {
      role: "assistant",
      content: "",
      timestamp: "2026-08-28T01:00:02.000Z",
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "computer_screenshot", arguments: "{}" },
      }],
    },
    {
      role: "tool",
      name: "computer_screenshot",
      tool_call_id: "call-1",
      timestamp: "2026-08-28T01:00:02.500Z",
      content: [
        { type: "text", text: `Screenshot captured.\nSaved to: ${screenshot}` },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA==" }, meta: { path: screenshot } },
      ],
    },
    {
      role: "assistant",
      content: "已打开 Apple 网站。",
      timestamp: "2026-08-28T01:00:03.000Z",
    },
  ]);
  const out = path.join(dir, "summary.md");
  const result = spawnSync(process.execPath, [script, "--file", session, "--out", out], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const markdown = fs.readFileSync(out, "utf8");
  assert.match(markdown, /title: "打开 Google Chrome 并访问 apple\.com"/);
  assert.match(markdown, /applications: \["com\.google\.Chrome"\]/);
  assert.match(markdown, /openai \/ gpt-5\.6-terra \(preset: computer-use-fast\)/);
  assert.match(markdown, /Tool call `computer_screenshot`/);
  assert.match(markdown, /Session status: `completed`/);
  assert.match(markdown, new RegExp(screenshot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("supports --last and reports omitted turns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-history-last-test-"));
  const session = writeFixture(dir, "cli_two_turns.jsonl", [
    { recordType: "metadata", key: "cli:two-turns", metadata: {} },
    { role: "user", content: "first request", timestamp: "2026-08-28T01:00:00.000Z" },
    { role: "assistant", content: "first answer", timestamp: "2026-08-28T01:00:01.000Z" },
    { role: "user", content: "second request", timestamp: "2026-08-28T01:01:00.000Z" },
    { role: "assistant", content: "second answer", timestamp: "2026-08-28T01:01:01.000Z" },
  ]);
  const out = path.join(dir, "summary.md");
  const result = spawnSync(process.execPath, [
    script,
    "--file", session,
    "--out", out,
    "--last", "1",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const markdown = fs.readFileSync(out, "utf8");
  assert.match(markdown, /title: "second request"/);
  assert.match(markdown, /省略了同一会话更早的 1 个用户轮次/);
  assert.doesNotMatch(markdown, /### Turn 1: first request/);
});

test("redacts common secrets and embedded image data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-history-redaction-test-"));
  const session = writeFixture(dir, "cli_secrets.jsonl", [
    { recordType: "metadata", key: "cli:secrets", metadata: {} },
    {
      role: "user",
      content: "use api_key=super-secret-value and sk-example1234567890",
      timestamp: "2026-08-28T01:00:00.000Z",
    },
    {
      role: "assistant",
      content: "Bearer abcdefghijklmnop and data:image/png;base64,QUJDREVGRw==",
      timestamp: "2026-08-28T01:00:01.000Z",
    },
  ]);
  const out = path.join(dir, "summary.md");
  const result = spawnSync(process.execPath, [script, "--file", session, "--out", out], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const markdown = fs.readFileSync(out, "utf8");
  assert.doesNotMatch(markdown, /super-secret-value|sk-example1234567890|abcdefghijklmnop|QUJDREVGRw/);
  assert.match(markdown, /\[REDACTED\]/);
  assert.match(markdown, /\[image base64 omitted\]/);
});

test("summarizes an explicit human-operation recording", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-human-history-test-"));
  const screenshot = path.join(dir, "screen.jpg");
  const recording = writeFixture(dir, "events.jsonl", [
    {
      recordType: "human_history_metadata",
      schemaVersion: 1,
      recordingId: "human:demo",
      title: "用 Spotlight 打开 Notes 并新建备忘录",
      createdAt: "2026-08-31T01:00:00.000Z",
      platform: "macOS",
      display: { width: 1512, height: 982 },
      contextUrl: "https://www.apple.com.cn/shop/buy-iphone/iphone-17-pro",
      captureText: true,
      allowedApplications: ["com.apple.Notes"],
    },
    {
      recordType: "human_event",
      sequence: 1,
      timestamp: "2026-08-31T01:00:01.000Z",
      eventType: "application_changed",
      application: { name: "Notes", bundleId: "com.apple.Notes", pid: 42 },
      details: {},
      screenshot,
    },
    {
      recordType: "human_event",
      sequence: 2,
      timestamp: "2026-08-31T01:00:02.000Z",
      eventType: "mouse_click",
      application: { name: "Notes", bundleId: "com.apple.Notes", pid: 42 },
      details: {
        x: 812,
        y: 406,
        button: "left",
        accessibility: {
          role: "AXButton",
          description: "新建备忘录",
          ancestors: [{ role: "AXToolbar", title: "备忘录工具栏" }],
        },
      },
    },
    {
      recordType: "human_event",
      sequence: 3,
      timestamp: "2026-08-31T01:00:03.000Z",
      eventType: "text_input",
      application: { name: "Notes", bundleId: "com.apple.Notes", pid: 42 },
      details: { text: "第一次人工录制", characterCount: 7, redacted: false },
    },
    {
      recordType: "human_event",
      sequence: 4,
      timestamp: "2026-08-31T01:00:04.000Z",
      eventType: "recording_stopped",
      application: { name: "Notes", bundleId: "com.apple.Notes", pid: 42 },
      details: { reason: "user_interrupt" },
    },
  ]);
  const out = path.join(dir, "summary.md");
  const result = spawnSync(process.execPath, [script, "--file", recording, "--out", out], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const markdown = fs.readFileSync(out, "utf8");
  assert.match(markdown, /source_type: human_computer_history/);
  assert.match(markdown, /experience_version: 1/);
  assert.match(markdown, /start_url: "https:\/\/www\.apple\.com\.cn\/shop\/buy-iphone\/iphone-17-pro"/);
  assert.match(markdown, /source_session: "human:demo"/);
  assert.match(markdown, /applications: \["com\.apple\.Notes"\]/);
  assert.match(markdown, /用户在「用 Spotlight 打开 Notes 并新建备忘录」中完成了一组电脑操作/);
  assert.doesNotMatch(markdown, /本次录制包含 \d+ 个操作事件/);
  assert.doesNotMatch(markdown, /用户主动开始和停止的单次 Demo 录制/);
  // The per-event ledger is gone: this is a summary, not a reformatted stream.
  assert.doesNotMatch(markdown, /## Activity timeline/);
  // The mechanical pass now writes a placeholder; the model writes the body.
  assert.match(markdown, /summary_state: pending/);
  assert.match(markdown, /（尚未生成）/);
  assert.doesNotMatch(markdown, /Semantic click target coverage/);
  assert.doesNotMatch(markdown, /Display: \d+x\d+/);
  assert.doesNotMatch(markdown, /Event counts/);
  assert.doesNotMatch(markdown, /## Reusable operation experience/);
  // The starting URL survives in the frontmatter, which the model does not own.
  assert.match(markdown, /start_url: "https:\/\/www\.apple\.com\.cn\/shop\/buy-iphone\/iphone-17-pro"/);
  // Applications stay in the frontmatter for the timeline to render.
  assert.match(markdown, /applications: \["com\.apple\.Notes"\]/);
  assert.match(markdown, /## Citations/);
  assert.doesNotMatch(markdown, /Recording started|Recording stopped|Recording status|Captured key screenshots/);
  assert.doesNotMatch(markdown, /\(812, 406\)/);
  // Typed text is evidence and stays in the event stream; the summary does not
  // reproduce it verbatim.
  assert.doesNotMatch(markdown, /第一次人工录制/);
  assert.match(markdown, new RegExp(screenshot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("enriches unlabeled clicks via descendants and records browser page context", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-human-history-page-test-"));
  const finalUrl = "https://www.apple.com/shop/buy-iphone/iphone-17-pro/6.3-inch-display-512gb-silver-unlocked";
  const recording = writeFixture(dir, "events.jsonl", [
    {
      recordType: "human_history_metadata",
      schemaVersion: 1,
      recordingId: "human:page-demo",
      title: "在 Apple 官网配置 iPhone",
      createdAt: "2026-09-01T01:00:00.000Z",
      platform: "macOS",
      display: { width: 1512, height: 982 },
      captureText: false,
    },
    {
      recordType: "human_event",
      sequence: 1,
      timestamp: "2026-09-01T01:00:01.000Z",
      eventType: "mouse_click",
      application: { name: "Google Chrome", bundleId: "com.google.Chrome", pid: 7 },
      details: {
        x: 630,
        y: 500,
        button: "left",
        accessibility: {
          role: "AXGroup",
          descendants: [{ role: "AXRadioButton", title: "512GB" }],
          ancestors: [{
            role: "AXGroup",
            subrole: "AXFieldset",
            description: "Storage. How much space do you need?",
          }],
        },
      },
    },
    {
      recordType: "human_event",
      sequence: 2,
      timestamp: "2026-09-01T01:00:02.000Z",
      eventType: "page_context",
      application: { name: "Google Chrome", bundleId: "com.google.Chrome", pid: 7 },
      details: { url: finalUrl, title: "Buy iPhone 17 Pro" },
    },
    {
      recordType: "human_event",
      sequence: 3,
      timestamp: "2026-09-01T01:00:03.000Z",
      eventType: "mouse_click",
      application: { name: "Google Chrome", bundleId: "com.google.Chrome", pid: 7 },
      details: { x: 100, y: 100, button: "left", accessibility: { role: "AXGroup" } },
    },
    {
      recordType: "human_event",
      sequence: 4,
      timestamp: "2026-09-01T01:00:04.000Z",
      eventType: "mouse_click",
      application: { name: "Google Chrome", bundleId: "com.google.Chrome", pid: 7 },
      details: {
        x: 640,
        y: 420,
        button: "left",
        accessibility: {
          role: "AXGroup",
          descendants: [{ role: "AXStaticText", value: "stale hit-test text" }],
          focused: { role: "AXRadioButton", title: "Silver" },
        },
      },
    },
    {
      recordType: "human_event",
      sequence: 5,
      timestamp: "2026-09-01T01:00:05.000Z",
      eventType: "recording_stopped",
      application: { name: "Google Chrome", bundleId: "com.google.Chrome", pid: 7 },
      details: { reason: "user_interrupt" },
    },
  ]);
  const out = path.join(dir, "summary.md");
  const result = spawnSync(process.execPath, [script, "--file", recording, "--out", out], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const markdown = fs.readFileSync(out, "utf8");
  // Click enrichment stays in the event stream, where the narrator reads it
  // (see summary-writer's compaction tests). The summary reports coverage
  // rather than replaying each click.
  assert.doesNotMatch(markdown, /## Activity timeline/);
  assert.match(markdown, /summary_state: pending/);
  assert.match(markdown, /applications: \["com\.google\.Chrome"\]/);
  // Page context now reaches the narrator through the event stream rather than
  // appearing as a replay instruction in the summary.
  assert.doesNotMatch(markdown, /Confirm the front browser page/);
  // End State was machine bookkeeping; the model states where the window ended
  // in prose instead.
  assert.doesNotMatch(markdown, /## End State/);
  // Replay guidance belongs to the workflow candidate, not to the summary.
  assert.doesNotMatch(markdown, /rely on the surrounding page context/);
});

test("finds the latest nested human recording", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-latest-human-history-test-"));
  const recordingDir = path.join(dir, "2026-08-31-human-demo");
  fs.mkdirSync(recordingDir);
  writeFixture(recordingDir, "events.jsonl", [
    {
      recordType: "human_history_metadata",
      recordingId: "human:latest-demo",
      title: "latest demo",
      createdAt: "2026-08-31T01:00:00.000Z",
    },
    {
      recordType: "human_event",
      sequence: 1,
      timestamp: "2026-08-31T01:00:01.000Z",
      eventType: "recording_stopped",
      application: { name: "Notes", bundleId: "com.apple.Notes" },
      details: { reason: "user_interrupt" },
    },
  ]);
  const out = path.join(dir, "summary.md");
  const result = spawnSync(process.execPath, [
    script,
    "--latest-recording",
    "--recordings-dir", dir,
    "--out", out,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(out, "utf8"), /source_session: "human:latest-demo"/);
});
