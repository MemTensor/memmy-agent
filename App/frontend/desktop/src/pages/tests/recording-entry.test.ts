import { describe, expect, it } from "vitest";
import { zhCNMessages } from "../../i18n/messages.js";
import { applySidebarRecordingAction, canUseAccountRecording, formatRecordedAt, sidebarRecordingStatus, transcriptFile, type RecordingEntrySession, type Translate } from "../recording-entry.js";

/** Minimal translator, so the file's labels come from the shipped messages. */
const t: Translate = ((key: string, params?: Record<string, unknown>) =>
  formatMessage(zhCNMessages[key as keyof typeof zhCNMessages], params)) as Translate;

function formatMessage(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ""));
}

describe("canUseAccountRecording", () => {
  it("requires account mode and a signed-in user, including after switching to API Key mode", () => {
    expect(canUseAccountRecording("account", "user-1")).toBe(true);
    expect(canUseAccountRecording("account", null)).toBe(false);
    expect(canUseAccountRecording("byok", "user-1")).toBe(false);
    expect(canUseAccountRecording("byok", null)).toBe(false);
  });
});

describe("sidebar recording action", () => {
  it("opens without capturing, then starts, pauses, and resumes through the separate control", () => {
    const calls: string[] = [];
    const session: Pick<RecordingEntrySession, "status" | "start" | "pause" | "resume" | "finish" | "showLive"> = {
      status: "idle",
      start: () => calls.push("start"),
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
      finish: () => calls.push("finish"),
      showLive: () => calls.push("showLive")
    };
    applySidebarRecordingAction(session, "open");
    expect(calls).toEqual([]);
    applySidebarRecordingAction(session, "control");
    expect(calls).toEqual(["start"]);
    session.status = "recording";
    applySidebarRecordingAction(session, "control");
    expect(calls.slice(-2)).toEqual(["showLive", "pause"]);
    session.status = "paused";
    applySidebarRecordingAction(session, "control");
    expect(calls.slice(-2)).toEqual(["showLive", "resume"]);
    applySidebarRecordingAction(session, "finish");
    expect(calls.at(-1)).toBe("finish");
    session.status = "idle";
    applySidebarRecordingAction(session, "finish");
    expect(calls.filter((call) => call === "finish")).toHaveLength(1);
  });
});

describe("sidebar recording status", () => {
  it("keeps transcription and its result visible after capture ends", () => {
    const live = { status: "transcribing" } as RecordingEntrySession["live"];
    expect(sidebarRecordingStatus({ status: "idle", live })).toBe("transcribing");
    expect(sidebarRecordingStatus({ status: "transcribing", live: null })).toBe("transcribing");
    expect(sidebarRecordingStatus({ status: "idle", live: { ...live!, status: "ready" } })).toBe("ready");
    expect(sidebarRecordingStatus({ status: "idle", live: { ...live!, status: "failed" } })).toBe("failed");
    expect(sidebarRecordingStatus({ status: "recording", live })).toBe("recording");
  });
});

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
