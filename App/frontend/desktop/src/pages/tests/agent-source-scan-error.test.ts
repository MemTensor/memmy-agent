import {
  AgentSourceViewSchema,
  type AgentSourceView,
  type ScanResult
} from "@memmy/local-api-contracts";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../api/http.js";
import {
  enUSMessages,
  formatMessage,
  zhCNMessages,
  type MessageKey,
  type MessageValues
} from "../../i18n/messages.js";
import {
  formatAgentSourceScanRequestError,
  formatScanCompletedError,
  type AgentSourceScanErrorTranslator
} from "../agent-source-scan-error.js";

const claudeSource = createSource({
  sourceId: "claude_code",
  displayName: "Claude Code",
  dataPath: "C:\\Users\\10970\\.claude\\projects"
});
const cursorSource = createSource({
  sourceId: "cursor",
  displayName: "Cursor",
  dataPath: "C:\\Users\\10970\\AppData\\Roaming\\Cursor\\User\\workspaceStorage"
});

describe("Agent source scan errors", () => {
  it("shows a localized path-not-found message without Node.js details", () => {
    const results = [
      failedScan(
        "claude_code",
        "ENOENT: no such file or directory, scandir 'C:\\Users\\10970\\.claude\\projects'"
      )
    ];

    const zhMessage = formatScanCompletedError(results, [claudeSource], translator("zh-CN"));
    const enMessage = formatScanCompletedError(results, [claudeSource], translator("en-US"));

    expect(zhMessage).toBe("找不到路径：C:\\Users\\10970\\.claude\\projects");
    expect(enMessage).toBe("Path not found: C:\\Users\\10970\\.claude\\projects");
    expect(zhMessage).not.toMatch(/ENOENT|scandir|claude_code/u);
    expect(enMessage).not.toMatch(/ENOENT|scandir|claude_code/u);
  });

  it("uses the configured source path when an unavailable error has no path", () => {
    const results = [
      failedScan("cursor", "Cursor is not installed or its directory is unavailable")
    ];

    expect(formatScanCompletedError(results, [cursorSource], translator("zh-CN"))).toBe(
      "找不到路径：C:\\Users\\10970\\AppData\\Roaming\\Cursor\\User\\workspaceStorage"
    );
    expect(formatScanCompletedError(results, [cursorSource], translator("en-US"))).toBe(
      "Path not found: C:\\Users\\10970\\AppData\\Roaming\\Cursor\\User\\workspaceStorage"
    );
  });

  it("hides non-path technical details behind a localized scan failure", () => {
    const results = [failedScan("cursor", "SQLITE_CORRUPT: database disk image is malformed")];

    const zhMessage = formatScanCompletedError(results, [cursorSource], translator("zh-CN"));
    const enMessage = formatScanCompletedError(results, [cursorSource], translator("en-US"));

    expect(zhMessage).toBe("扫描 Cursor 失败，请稍后重试。");
    expect(enMessage).toBe("Failed to scan Cursor. Please try again.");
    expect(zhMessage).not.toContain("SQLITE_CORRUPT");
    expect(enMessage).not.toContain("database disk image");
  });

  it("localizes scan request failures before they enter GUI state", () => {
    const error = new ApiRequestError(
      "Claude Code is not installed or its directory is unavailable",
      409,
      "agent_source_unavailable",
      "req-1"
    );

    expect(formatAgentSourceScanRequestError(error, claudeSource, translator("zh-CN"))).toBe(
      "找不到路径：C:\\Users\\10970\\.claude\\projects"
    );
    expect(formatAgentSourceScanRequestError(error, claudeSource, translator("en-US"))).toBe(
      "Path not found: C:\\Users\\10970\\.claude\\projects"
    );
  });
});

function translator(language: "zh-CN" | "en-US"): AgentSourceScanErrorTranslator {
  const catalog = language === "zh-CN" ? zhCNMessages : enUSMessages;
  return (key: MessageKey, values?: MessageValues) => formatMessage(catalog[key], values);
}

function failedScan(sourceId: string, reason: string): ScanResult {
  return {
    sourceId,
    discoveredConversations: 0,
    emittedMessages: 0,
    skipped: 0,
    errors: [{ conversationId: "scan", reason }]
  };
}

function createSource(input: Pick<AgentSourceView, "sourceId" | "displayName" | "dataPath">): AgentSourceView {
  return AgentSourceViewSchema.parse({
    ...input,
    builtin: true,
    available: true,
    status: "not_connected",
    messageCount: 0,
    lastScannedAt: null
  });
}
