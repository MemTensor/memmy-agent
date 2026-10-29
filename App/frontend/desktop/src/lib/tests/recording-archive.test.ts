// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { readRecordingArchive, removeRecordingArchiveEntry, saveRecordingArchiveEntry } from "../recording-archive.js";
import type { RecordingArchiveEntry } from "../../pages/recording-entry.js";

it("removes a recording from the persisted list without deleting task files", () => {
  const scope = `recording-remove-${Date.now()}`;
  const entry: RecordingArchiveEntry = {
    id: "rec-1", title: "访谈录音", recordedAt: "2026-10-26T12:00:00.000Z",
    durationMs: 4000, speakerCount: 1, transcript: { text: "内容", segments: [] },
    audioUrl: null, audioPath: "/task/audio.webm", status: "ready"
  };
  saveRecordingArchiveEntry(scope, entry);
  expect(readRecordingArchive(scope)).toHaveLength(1);

  removeRecordingArchiveEntry(scope, entry.id);
  expect(readRecordingArchive(scope)).toEqual([]);
  expect(JSON.parse(window.localStorage.getItem(`memmy.recordingArchive.v1:${scope}`) ?? "null")).toEqual([]);
  expect(entry.audioPath).toBe("/task/audio.webm");
});
