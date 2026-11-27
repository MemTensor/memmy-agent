import { expect, it } from "vitest";
import type { InstalledPlugin } from "@memmy/local-api-contracts";
import { buildPluginCapabilityLabels } from "../plugin-tool-activity.js";

const plugins = [{ manifest: { capabilities: [
  { id: "recording_stop", name: "录制完成", nameLocalized: { "en-US": "Finish recording" } },
  { id: "recording_start", name: "开始录制" },
] } }] as unknown as InstalledPlugin[];

it("uses the manifest name for the current UI language and falls back to name", () => {
  expect(buildPluginCapabilityLabels(plugins, "zh-CN").get("recording_stop")).toBe("录制完成");
  expect(buildPluginCapabilityLabels(plugins, "en-US").get("recording_stop")).toBe("Finish recording");
  // A capability without a localized name keeps its manifest name in every language.
  expect(buildPluginCapabilityLabels(plugins, "en-US").get("recording_start")).toBe("开始录制");
  // Older callers that pass no language keep the default Chinese labels.
  expect(buildPluginCapabilityLabels(plugins).get("recording_stop")).toBe("录制完成");
});
