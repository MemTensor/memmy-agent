import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import lockfile from "proper-lockfile";
import { DEFAULT_OBSERVATION_SETTINGS, ObservationSettingsError, parseObservationSettings,
  type ObservationSettings } from "./observation-settings.js";

export function defaultSettingsFile(): string {
  return path.join(os.homedir(), ".memmy", "computer-history", "observation-settings.json");
}
export class ObservationSettingsConflict extends Error {}

/** Atomic policy replacement. Revisions prevent an older editor overwriting a newer policy. */
export class ObservationSettingsStore {
  private readonly file: string;
  constructor(file?: string) { this.file = file ?? defaultSettingsFile(); }
  get filePath(): string { return this.file; }

  snapshot(): { settings: ObservationSettings; revision: string } {
    let raw: string;
    try { raw = fs.readFileSync(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { settings: structuredClone(DEFAULT_OBSERVATION_SETTINGS), revision: "missing" };
      }
      throw error;
    }
    try {
      return { settings: parseObservationSettings(JSON.parse(raw)),
        revision: crypto.createHash("sha256").update(raw).digest("hex") };
    } catch { throw new ObservationSettingsError("Computer History settings are invalid; repair the settings file before editing."); }
  }

  read(): ObservationSettings {
    try { return this.snapshot().settings; }
    catch { return { observation: { defaultApplicationBehavior: "do_not_observe",
      defaultURLBehavior: "do_not_observe", rules: [] } }; }
  }

  write(input: unknown, expectedRevision?: string): ObservationSettings {
    const settings = parseObservationSettings(input);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let release: () => void;
    try { release = lockfile.lockSync(this.file, { realpath: false }); }
    catch { throw new ObservationSettingsConflict("Settings are being updated. Reload and try again."); }
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      if (expectedRevision !== undefined && this.snapshot().revision !== expectedRevision) {
        throw new ObservationSettingsConflict("Settings changed in another window. Reload before saving.");
      }
      // A unique write identity also detects change-away-and-back (ABA).
      fs.writeFileSync(temporary, `${JSON.stringify({ ...settings, revision: crypto.randomUUID() }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, this.file);
      return settings;
    } finally {
      fs.rmSync(temporary, { force: true });
      release();
    }
  }
}
export { ObservationSettingsError };
