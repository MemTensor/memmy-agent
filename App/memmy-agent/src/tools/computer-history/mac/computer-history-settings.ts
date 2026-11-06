import { Tool } from "../../../core/agent-runtime/tools/base.js";
import { getComputerHistoryDemoService } from "../computer-history-api.js";
import type { ComputerHistoryDemoService } from "./computer-history-api.js";
import { isComputerHistorySupported } from "../platform.js";
import { collectorGate } from "../core/collector-gate.js";
import {
  ObservationSettingsError,
  ObservationSettingsStore,
} from "./settings-store.js";

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
    return isComputerHistorySupported() && process.env.MEMMY_COMPUTER_HISTORY !== "0";
  }

  get name(): string { return "computer_history_status"; }

  get description(): string {
    return [
      "Report whether Computer History is recording, and where its data lives.",
      "Returns two paths: summary_directory holds the readable per-window summaries, and event_stream_root_path holds the raw per-segment event streams.",
      "Read both with your own file tools; the summaries locate a window, the raw stream answers what specifically happened in it.",
      "Call this before relying on Computer History data.",
      "A running state reports the recorder lifecycle; it does not establish complete browser or application coverage.",
      "Check capture_health for connection signals, the most recent successful event write, partial-capture issues, and known limitations. No recent event alone does not establish failure: the user may be idle.",
      "For actions just performed, inspect the active raw stream at <event_stream_root_path>/<segment_id>/events.jsonl and adjacent UTC segments, even if the current summary is absent or incomplete.",
      "A negative search means only 'not found in the captured records searched'; report those sources and their time window, and never infer that the user did not act or the action never happened.",
      "If the user confirms a browser action but the relevant raw streams contain no browser events or page URLs, acknowledge a capture coverage gap; missing capture evidence cannot establish what happened in the browser.",
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
      capture_health: snapshot.observation.captureHealth ?? null,
      wechat: snapshot.wechat ?? null,
      // Two different things: the summaries answer "what was I doing", the raw
      // streams answer "who said what". Report both so the agent can pick.
      summary_directory: snapshot.privacy.markdownDirectory,
      event_stream_root_path: snapshot.privacy.eventStreamDirectory,
      settings_path: this.store.filePath,
      privacy: {
        screenshots: snapshot.privacy.screenshots,
        audio: snapshot.privacy.audio,
        raw_retention_hours: snapshot.privacy.rawRetentionHours,
        separate_sources: "Personal WeChat requires its own explicit source permission and connection. It has an independent reader status; a running screen recorder does not establish WeChat coverage.",
        system_surfaces: "The login window and screen saver are never recorded.",
        capture_scope: "Foreground applications and the controls/text they expose to accessibility only. Images, audio, unreadable controls, and content beyond the sampled window are not complete activity evidence.",
      },
    });
  }
}

export class ComputerHistoryGetSettingsTool extends Tool {
  static scopes = new Set(["core"]);
  private readonly store?: ObservationSettingsStore;
  private readonly service?: Pick<ComputerHistoryDemoService, "getObservationSettings">;

  constructor(store?: ObservationSettingsStore) {
    super();
    this.store = store;
    this.service = store ? undefined : getComputerHistoryDemoService();
  }

  static enabled(): boolean {
    return isComputerHistorySupported() && process.env.MEMMY_COMPUTER_HISTORY !== "0";
  }

  get name(): string { return "computer_history_get_settings"; }

  get description(): string {
    return [
      "Read the complete Computer History observation settings document.",
      "Always call this immediately before computer_history_update_settings.",
      "Application and website rules control permission to observe, not whether an application exposes readable content or the recorder supports it. Check computer_history_status.capture_health before claiming coverage.",
    ].join(" ");
  }

  get parameters() { return structuredClone(NO_PARAMETERS); }

  async execute(): Promise<string> {
    return JSON.stringify({ status: "ok", settings: this.store?.read() ?? this.service!.getObservationSettings() });
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
  private readonly store?: ObservationSettingsStore;
  private readonly service?: Pick<ComputerHistoryDemoService, "updateObservationSettings">;

  constructor(store?: ObservationSettingsStore) {
    super();
    this.store = store;
    this.service = store ? undefined : getComputerHistoryDemoService();
  }

  static enabled(): boolean {
    return isComputerHistorySupported() && process.env.MEMMY_COMPUTER_HISTORY !== "0";
  }

  get name(): string { return "computer_history_update_settings"; }

  get description(): string {
    return [
      "Replace the Computer History observation settings document.",
      "This replaces the whole document, so call computer_history_get_settings first and preserve every field and rule the user did not ask to change.",
      "defaultApplicationBehavior controls applications that match no app rule; defaultURLBehavior independently controls websites that match no URL rule.",
      "On Windows, application identities use windows: IDs; an optional absolute executable path binds a rule to that exact application. Existing win32.* rules remain compatible.",
      "Ask the user before changing either default, because switching between default-observe and default-don't-observe materially changes how much is recorded.",
    ].join(" ");
  }

  get parameters() { return structuredClone(UPDATE_PARAMETERS); }

  async execute(params: { settings: unknown }): Promise<string> {
    if (collectorGate.taskActive) return "Error: stop task recording before changing Computer History settings";
    try {
      const settings = this.store ? this.store.write(params.settings) : await this.service!.updateObservationSettings(params.settings);
      return JSON.stringify({ status: "ok", settings });
    } catch (error) {
      if (error instanceof ObservationSettingsError) {
        return `Error: invalid Computer History settings: ${error.message}`;
      }
      throw error;
    }
  }
}
