import { Tool } from "./base.js";
import { getComputerHistoryDemoService } from "../../../entrypoints/frontend-bridge/computer-history-api.js";
import type { ComputerHistoryDemoService } from "../../../entrypoints/frontend-bridge/computer-history-api.js";
import {
  ObservationSettingsError,
  ObservationSettingsStore,
} from "../computer-history/settings-store.js";

// The recorder's own lifecycle vocabulary. `paused` keeps the current segment
// but stops writing to it; `stopped` records nothing while previously completed
// segments stay searchable.
export type ComputerHistoryRunState = "running" | "paused" | "stopped" | "stopping" | "failed";

export function runStateFrom(state: string): ComputerHistoryRunState {
  switch (state) {
    case "running": return "running";
    case "paused": return "paused";
    case "stopping": return "stopping";
    case "failed": return "failed";
    default: return "stopped";
  }
}

const NO_PARAMETERS = { type: "object", properties: {}, additionalProperties: false };

export class ComputerHistoryStatusTool extends Tool {
  static scopes = new Set(["core"]);
  private readonly service: Pick<ComputerHistoryDemoService, "snapshot">;
  private readonly store: ObservationSettingsStore;

  constructor(service = getComputerHistoryDemoService(), store = new ObservationSettingsStore()) {
    super();
    this.service = service;
    this.store = store;
  }

  static enabled(): boolean {
    return process.env.MEMMY_COMPUTER_HISTORY !== "0";
  }

  get name(): string { return "computer_history_status"; }

  get description(): string {
    return [
      "Report whether Computer History is recording, and where its event stream lives.",
      "Call this before relying on Computer History data.",
      "If it is stopped and the user expects fresh data, offer to start it; if paused, offer to resume it.",
    ].join(" ");
  }

  get parameters() { return structuredClone(NO_PARAMETERS); }

  async execute(): Promise<string> {
    const snapshot = this.service.snapshot();
    return JSON.stringify({
      status: "ok",
      state: runStateFrom(snapshot.observation.state),
      started_at: snapshot.observation.startedAt,
      segment_id: snapshot.observation.segmentId,
      error: snapshot.observation.error,
      event_stream_root_path: snapshot.privacy.markdownDirectory,
      settings_path: this.store.filePath,
      privacy: {
        screenshots: snapshot.privacy.screenshots,
        audio: snapshot.privacy.audio,
        raw_retention_hours: snapshot.privacy.rawRetentionHours,
      },
    });
  }
}

export class ComputerHistoryGetSettingsTool extends Tool {
  static scopes = new Set(["core"]);
  private readonly store: ObservationSettingsStore;

  constructor(store = new ObservationSettingsStore()) {
    super();
    this.store = store;
  }

  static enabled(): boolean {
    return process.env.MEMMY_COMPUTER_HISTORY !== "0";
  }

  get name(): string { return "computer_history_get_settings"; }

  get description(): string {
    return [
      "Read the complete Computer History observation settings document.",
      "Always call this immediately before computer_history_update_settings.",
    ].join(" ");
  }

  get parameters() { return structuredClone(NO_PARAMETERS); }

  async execute(): Promise<string> {
    return JSON.stringify({ status: "ok", settings: this.store.read() });
  }
}

const UPDATE_PARAMETERS = {
  type: "object",
  properties: {
    settings: {
      type: "object",
      description: "The complete settings document, exactly as returned by computer_history_get_settings, with your changes applied.",
    },
  },
  required: ["settings"],
  additionalProperties: false,
};

export class ComputerHistoryUpdateSettingsTool extends Tool {
  static scopes = new Set(["core"]);
  private readonly store: ObservationSettingsStore;

  constructor(store = new ObservationSettingsStore()) {
    super();
    this.store = store;
  }

  static enabled(): boolean {
    return process.env.MEMMY_COMPUTER_HISTORY !== "0";
  }

  get name(): string { return "computer_history_update_settings"; }

  get description(): string {
    return [
      "Replace the Computer History observation settings document.",
      "This replaces the whole document, so call computer_history_get_settings first and preserve every field and rule the user did not ask to change.",
      "defaultApplicationBehavior controls applications that match no app rule; defaultURLBehavior independently controls websites that match no URL rule.",
      "Ask the user before changing either default, because switching between default-observe and default-don't-observe materially changes how much is recorded.",
    ].join(" ");
  }

  get parameters() { return structuredClone(UPDATE_PARAMETERS); }

  async execute(params: { settings: unknown }): Promise<string> {
    try {
      const settings = this.store.write(params.settings);
      return JSON.stringify({ status: "ok", settings });
    } catch (error) {
      if (error instanceof ObservationSettingsError) {
        return `Error: invalid Computer History settings: ${error.message}`;
      }
      throw error;
    }
  }
}
