import { describe, expect, it } from "vitest";
import { zhCNMessages } from "../../i18n/messages.js";
import { formatRecordedAt, transcriptFile, type Translate } from "../recording-entry.js";

/** Minimal translator, so the file's labels come from the shipped messages. */
const t: Translate = ((key: string, params?: Record<string, unknown>) =>
  formatMessage(zhCNMessages[key as keyof typeof zhCNMessages], params)) as Translate;

function formatMessage(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ""));
}

describe("formatRecordedAt", () => {
  it("shows the stamp the way the recording list does", () => {
    // The design's row reads `2026-09-07 09:30`, local time.
    const at = new Date(2026, 8, 7, 9, 30);
    expect(formatRecordedAt(at.toISOString())).toBe("2026-09-07 09:30");
  });

  it("pads single-digit months, days and times", () => {
    expect(formatRecordedAt(new Date(2026, 0, 5, 8, 4).toISOString())).toBe("2026-01-05 08:04");
  });

  it("shows nothing rather than an invalid date", () => {
    expect(formatRecordedAt("not a timestamp")).toBe("");
  });
});

describe("transcriptFile", () => {
  const entry = {
    id: "rec-1",
    title: "示例-制造企业用工访谈",
    recordedAt: "2026-09-07T01:30:00.000Z",
    durationMs: 46_000,
    speakerCount: 2,
    transcript: {
      text: "你连接到配置中心的时候要看变量名称。",
      segments: [
        { text: "你连接到配置中心的时候", speakerId: 0, startMs: 0 },
        { text: "要看变量名称。", speakerId: 1, startMs: 12_000 }
      ]
    },
    audioUrl: null
  };

  it("carries the timestamp, the speaker and the words", () => {
    // 添加到会话 and 总结 both send this file, so it has to stand on its own:
    // the reader sees it in the conversation with no other context.
    const file = transcriptFile(entry, t);
    expect(file.name).toBe("示例-制造企业用工访谈.txt");
    expect(file.type).toBe("text/plain");
  });

  it("falls back to the flat text when no speaker was separated", async () => {
    const flat = transcriptFile({
      ...entry,
      transcript: { text: "一段没有发言人的转写", segments: [] }
    }, t);
    expect(await flat.text()).toBe("一段没有发言人的转写");
  });

  it("keeps the timecodes and speaker labels in the written file", async () => {
    const text = await transcriptFile(entry, t).text();
    expect(text).toContain("[00:00] 【说话人 1】你连接到配置中心的时候");
    expect(text).toContain("[00:12] 【说话人 2】要看变量名称。");
  });
});
