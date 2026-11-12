import { useSyncExternalStore } from "react";
import { z } from "zod";
import { UploadedAgentMediaSchema } from "../api/memmy-agent-client.js";
import type { RecordingArchiveEntry } from "../pages/recording-entry.js";

const schema = z.object({
  id: z.string(), title: z.string(), recordedAt: z.string(), durationMs: z.number(), speakerCount: z.number(),
  audioPath: z.string(), sessionKey: z.string().optional(),
  files: z.array(UploadedAgentMediaSchema).optional(),
  transcript: z.object({ text: z.string(), segments: z.array(z.object({
    text: z.string(), speakerId: z.number().optional(), startMs: z.number().optional(), endMs: z.number().optional()
  })) }),
  status: z.enum(["ready", "failed", "transcribing"]).optional()
});
const empty: RecordingArchiveEntry[] = [];
const snapshots = new Map<string, RecordingArchiveEntry[]>();
const listeners = new Map<string, Set<() => void>>();
const key = (scope: string) => `memmy.recordingArchive.v1:${scope}`;

export function readRecordingArchive(scope: string): RecordingArchiveEntry[] {
  const cached = snapshots.get(scope);
  if (cached) return cached;
  let entries = empty;
  try {
    const parsed = z.array(schema).safeParse(JSON.parse(window.localStorage.getItem(key(scope)) ?? "[]"));
    if (parsed.success) entries = parsed.data.map((entry) => ({ ...entry, audioUrl: null }));
  } catch { /* A damaged or unavailable storage entry must not break the chat. */ }
  snapshots.set(scope, entries);
  return entries;
}

export function saveRecordingArchiveEntry(scope: string, entry: RecordingArchiveEntry): void {
  const previous = readRecordingArchive(scope);
  const next = [entry, ...previous.filter((row) => row.id !== entry.id
    && (!entry.audioPath || row.audioPath !== entry.audioPath))]
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  snapshots.set(scope, next);
  try {
    // Playback URLs are short-lived bearer capabilities; retain paths instead.
    window.localStorage.setItem(key(scope), JSON.stringify(next.filter((row) => row.audioPath).map(({ audioUrl: _url, files, ...row }) => ({ ...row,
      ...(files ? { files: files.map((file) => ({ ...file, url: "" })) } : {})
    }))));
  } catch { /* Keep the in-memory archive if local storage is temporarily full. */ }
  for (const notify of listeners.get(scope) ?? []) notify();
}

export function removeRecordingArchiveEntry(scope: string, id: string): void {
  const next = readRecordingArchive(scope).filter((row) => row.id !== id);
  snapshots.set(scope, next);
  try {
    window.localStorage.setItem(key(scope), JSON.stringify(next.map(({ audioUrl: _url, files, ...row }) => ({ ...row,
      ...(files ? { files: files.map((file) => ({ ...file, url: "" })) } : {})
    }))));
  } catch { /* The in-memory list still reflects the user's deletion. */ }
  for (const notify of listeners.get(scope) ?? []) notify();
}

export function useRecordingArchive(scope?: string): RecordingArchiveEntry[] {
  return useSyncExternalStore(
    (notify) => {
      if (!scope) return () => undefined;
      const bucket = listeners.get(scope) ?? new Set();bucket.add(notify);listeners.set(scope, bucket);
      return () => { bucket.delete(notify); };
    },
    () => scope ? readRecordingArchive(scope) : empty,
    () => empty
  );
}
