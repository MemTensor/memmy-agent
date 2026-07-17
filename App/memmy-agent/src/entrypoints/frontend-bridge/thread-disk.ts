import fs from "node:fs";
import path from "node:path";
import { getWebuiDir } from "../../config/paths.js";
import { deleteWebuiTranscript } from "./transcript.js";

const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*]/g;

function safeFilename(name: string): string {
  return name.replace(UNSAFE_FILENAME_CHARS, "_").trim();
}

function safeSessionStem(sessionKey: string): string {
  return safeFilename(String(sessionKey).replace(/:/g, "_"));
}

export function webuiThreadFilePath(sessionKey: string): string;
export function webuiThreadFilePath(root: string, id: string): string;
export function webuiThreadFilePath(sessionKeyOrRoot: string, id?: string): string {
  if (id !== undefined) return path.join(sessionKeyOrRoot, `${id}.json`);
  return path.join(getWebuiDir(), `${safeSessionStem(sessionKeyOrRoot)}.json`);
}

export function deleteWebuiThread(sessionKey: string): boolean;
export function deleteWebuiThread(root: string, id: string): boolean;
export function deleteWebuiThread(sessionKeyOrRoot: string, id?: string): boolean {
  let removed = false;
  const file = id === undefined ? webuiThreadFilePath(sessionKeyOrRoot) : webuiThreadFilePath(sessionKeyOrRoot, id);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    try {
      fs.unlinkSync(file);
      removed = true;
    } catch {
      // Keep trying to remove the transcript below.
    }
  }
  removed = (id === undefined ? deleteWebuiTranscript(sessionKeyOrRoot) : deleteWebuiTranscript(sessionKeyOrRoot, id)) || removed;
  return removed;
}
