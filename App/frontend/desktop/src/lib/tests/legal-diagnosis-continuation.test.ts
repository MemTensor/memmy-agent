import { describe, expect, it } from "vitest";
import { buildLegalDiagnosisContinuationPrompt } from "../legal-diagnosis-continuation.js";

describe("legal diagnosis continuation instructions", () => {
  it.each(["session-1", '会话"with\n$& and {sessionId}'])
    ("preserves the existing agent protocol instructions and escapes session %s", (sessionId) => {
      const expected = `/legal-diagnosis 已完成调研，继续已有法律诊断会话，sessionId=${JSON.stringify(sessionId)}。`
        + "请使用这个 sessionId 调用 session-status 核对已上传材料与进度，再继续后续诊断并生成报告。"
        + "本次是已有会话的继续操作，请跳过 skill 中新建会话的 session-start 步骤，不要再次弹出诊断指引或重复收集材料。";
      expect(buildLegalDiagnosisContinuationPrompt(sessionId)).toBe(expected);
    });
});
