import { describe, expect, it } from "vitest";
import {
  fallbackCaptureSummary,
  normalizeCaptureSummaryUserText,
  sanitizeCaptureSummary
} from "../../../src/service/evolution/capture-summary.js";

const generatedAttachmentTurn = [
  "<attachments>",
  "- hypre.txt  (application/octet-stream, 15.4MB)  /Users/test/.memmy/media/hypre.txt",
  "",
  "请用 read_file 工具按需读取上述附件；PDF 可用 pages 参数分页读取。",
  "</attachments>",
  "",
  "这个文件的内容是什么？"
].join("\n");

describe("capture summary attachment normalization", () => {
  it("moves the real request ahead of bounded attachment metadata", () => {
    expect(normalizeCaptureSummaryUserText(generatedAttachmentTurn)).toEqual({
      requestText: "这个文件的内容是什么？",
      attachmentMetadata: ["hypre.txt (application/octet-stream, 15.4MB)"],
      recognizedAttachmentManifest: true
    });
  });

  it("does not strip user-authored attachment XML without Memmy's manifest shape", () => {
    const userText = "<attachments>\n这是用户正在讨论的 XML 示例。\n</attachments>";

    expect(normalizeCaptureSummaryUserText(userText)).toEqual({
      requestText: userText,
      attachmentMetadata: [],
      recognizedAttachmentManifest: false
    });
  });

  it("replaces wrapper-only model summaries with the assistant's semantic result", () => {
    const source = {
      userText: generatedAttachmentTurn,
      agentText: "这个附件是一个 **HYPRE 2.31.0 源码集合**，包含并行求解器实现。",
      toolCalls: [{ name: "read_file", output: "set(HYPRE_VERSION 2.31.0)" }]
    };

    expect(sanitizeCaptureSummary("<attachments>", source)).toBe(
      "这个附件是一个 HYPRE 2.31.0 源码集合，包含并行求解器实现。"
    );
    expect(fallbackCaptureSummary(source)).not.toContain("<attachments>");
  });
});
