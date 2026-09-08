import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_OBSERVATION_SETTINGS,
  ObservationSettingsError,
  parseObservationSettings,
  type ObservationSettings,
} from "./observation-settings.js";

export function defaultSettingsFile(): string {
  return path.join(os.homedir(), ".memmy", "computer-history", "observation-settings.json");
}

/**
 * Persists the observation policy.
 *
 * Reads are forgiving — a missing or corrupt file falls back to the safe
 * default rather than leaving the recorder without a policy. Writes are strict:
 * the document is validated in full, because a write replaces the previous one.
 */
export class ObservationSettingsStore {
  private readonly file: string;

  constructor(file?: string) {
    this.file = file ?? defaultSettingsFile();
  }

  get filePath(): string {
    return this.file;
  }

  read(): ObservationSettings {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return structuredClone(DEFAULT_OBSERVATION_SETTINGS);
    }
    try {
      return parseObservationSettings(JSON.parse(raw));
    } catch {
      return structuredClone(DEFAULT_OBSERVATION_SETTINGS);
    }
  }

  write(input: unknown): ObservationSettings {
    const settings = parseObservationSettings(input);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return settings;
  }
}

export { ObservationSettingsError };
