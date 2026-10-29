// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstalledPluginSchema } from "@memmy/local-api-contracts";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { collectPluginCommandTargets, PinnedPluginCommandBar } from "../home-page.js";
import { RecordingEntryCard, RecordingEntryPage, useRecordingEntry, type RecordingEntryController } from "../recording-entry.js";

const here = import.meta.dirname;

const recorder = vi.hoisted(() => ({
  status: "idle" as "idle" | "recording", isRecording: false, isStarting: false, isTranscribing: false, error: null,
  start: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), finishAndTranscribe: vi.fn()
}));
vi.mock("../asr-recorder.js", async (original) => ({
  ...await original<typeof import("../asr-recorder.js")>(), useAsrRecorder: () => recorder
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plugin = InstalledPluginSchema.parse({
  id: "legal-labor", version: "1.0.0", manifest: {
    apiVersion: "memmy/v1", id: "legal-labor", name: "用工合规诊断", version: "1.0.0", runtime: { adapter: "http" },
    capabilities: [{ id: "material-collect", name: "收集材料", description: "收集材料", inputSchema: {}, outputSchema: {}, execution: "job" }],
    commands: [
      { command: "/legal-record", name: "访谈录音", description: "访谈录音", capabilityId: "material-collect", pinned: true, topbar: true },
      { command: "/upload", name: "上传材料", description: "上传材料", capabilityId: "material-collect", pinned: true }
    ], permissions: []
  }, state: "active", approvedPermissions: [], config: {}, lastError: null,
  createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z"
});

describe("independent interview recording entries", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: RecordingEntryController;
  const invokePlugin = vi.fn();
  const deliver = vi.fn();

  function Page() {
    current = useRecordingEntry({} as never, undefined, deliver);
    return <>
      <button data-testid="topbar" onClick={current.toggle}>录音图标</button>
      <PinnedPluginCommandBar targets={collectPluginCommandTargets([plugin])} disabled={false}
        active={new Set(["legal-labor:material-collect"])} recordingOpen={current.compactOpen}
        onRecordingPress={current.toggleCompact} onPress={invokePlugin} />
      {current.compactOpen ? <RecordingEntryCard session={current.session} onClose={current.closeCompact}
        onOpenList={() => { if (!current.open) current.toggle(); }} /> : null}
      {current.open ? <RecordingEntryPage session={current.session} /> : null}
    </>;
  }

  const click = async (selector: string) => act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
  const pinned = '.pinned-command-chip[title="访谈录音"]';

  beforeEach(async () => {
    vi.clearAllMocks();
    recorder.status = "idle";
    recorder.isRecording = false;
    recorder.start.mockImplementation(async () => { recorder.status = "recording"; recorder.isRecording = true; });
    recorder.finishAndTranscribe.mockImplementation(async (options) => {
      const recording = new Blob(["audio"]);
      recorder.status = "idle";
      recorder.isRecording = false;
      options.onRecordingReady?.(recording, "audio/webm", 4000);
      return { recording, recordingMimeType: "audio/webm", durationMs: 4000,
        text: "访谈内容", segments: [], transcribedAt: new Date().toISOString() };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<I18nProvider language="zh-CN"><Page /></I18nProvider>));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("starts and finishes once when both recording views are clicked before state updates", async () => {
    let started!: () => void;
    recorder.start.mockImplementation(() => new Promise<void>((resolve) => { started = () => {
      recorder.status = "recording"; recorder.isRecording = true; resolve();
    }; }));
    await act(async () => { current.session.start(); current.session.start(); current.toggleCompact(); current.toggle(); });
    expect(recorder.start).toHaveBeenCalledTimes(1);
    await act(async () => started());
    const originalFinish = recorder.finishAndTranscribe.getMockImplementation()!;
    let finished!: () => void;
    const gate = new Promise<void>((resolve) => { finished = resolve; });
    recorder.finishAndTranscribe.mockImplementation(async (options) => { await gate; return originalFinish(options); });
    await act(async () => { current.session.finish(); current.session.finish(); current.closeCompact(); });
    expect(recorder.finishAndTranscribe).toHaveBeenCalledTimes(1);
    await act(async () => finished());
    expect(current.session.recordings).toHaveLength(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(recorder.cancel).not.toHaveBeenCalled();
  });

  it("opens a compact card from the composer and the list from the top bar", async () => {
    expect(container.querySelector(pinned)?.getAttribute("aria-pressed")).toBe("false");
    await click(pinned);
    expect(container.querySelector(".recording-entry-card")).not.toBeNull();
    expect(container.querySelector(".recording-page")).toBeNull();
    expect(current.open).toBe(false);
    expect(recorder.start).not.toHaveBeenCalled();
    const idleBars = Array.from(container.querySelectorAll<HTMLElement>(".recording-waveform__bar"));
    expect(new Set(idleBars.map((bar) => bar.style.height)).size).toBeGreaterThan(1);
    // The row has to fit the narrowest place it appears: bars clipped
    // mid-width are what made the wave read as bars of uneven thickness, and a
    // fractional bar width lets each one round to a different device pixel.
    // Read from the stylesheet — the test environment does not apply it.
    const css = readFileSync(resolve(here, "../conversation-features.css"), "utf8");
    const barRule = /\.recording-waveform__bar \{[^}]*width: ([0-9.]+)px/.exec(css);
    const rowRule = /\.recording-waveform \{[^}]*gap: ([0-9.]+)px/.exec(css);
    expect(barRule).not.toBeNull();
    expect(rowRule).not.toBeNull();
    const barWidth = Number(barRule![1]);
    const gap = Number(rowRule![1]);
    // An integer width, so every bar lands on the same pixel boundary.
    expect(Number.isInteger(barWidth)).toBe(true);
    expect(barWidth * idleBars.length + gap * (idleBars.length - 1)).toBeLessThanOrEqual(137);
    await click('[data-testid="topbar"]');
    expect(container.textContent).toContain("录音列表");
    expect(current.compactOpen).toBe(true);
    await click(pinned);
    expect(container.querySelector(".recording-entry-card")).toBeNull();
    expect(current.open).toBe(true);
    expect(invokePlugin).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("shares recording controls and preserves the microphone when either view closes", async () => {
    await click(pinned);
    await click('.recording-entry-card .recording-bar__button--primary');
    expect(current.session.status).toBe("recording");
    expect(container.querySelector(".recording-waveform--idle")).toBeNull();
    // Silent recording uses actual zero levels, never the decorative idle wave.
    expect(Array.from(container.querySelectorAll<HTMLElement>(".recording-waveform__bar"))
      .every((bar) => bar.style.height === "8%")).toBe(true);
    expect(current.open).toBe(true);
    expect(current.session.view).toBe("live");
    await act(async () => current.session.back());
    expect(current.session.view).toBe("list");
    expect(container.querySelector(".recording-page__list-row--active")).not.toBeNull();
    await act(async () => current.session.showLive());
    await click('.recording-entry-card .recording-bar__button:not(.recording-bar__button--primary)');
    expect(recorder.pause).toHaveBeenCalledTimes(1);
    await click('.recording-entry-card .recording-bar__close');
    expect(current.compactOpen).toBe(false);
    expect(current.open).toBe(true);
    await act(async () => current.close());
    await click(pinned);
    expect(current.session.status).toBe("recording");
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(recorder.cancel).not.toHaveBeenCalled();
    expect(recorder.finishAndTranscribe).not.toHaveBeenCalled();
    expect(invokePlugin).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("archives compact recordings in the sidebar without opening diagnosis materials or sending to the Agent", async () => {
    await click(pinned);
    for (const now of [1000, 2000]) {
      vi.spyOn(Date, "now").mockReturnValue(now);
      await click('.recording-entry-card .recording-bar__button--primary');
      await click('.recording-entry-card .recording-bar__button--primary');
    }
    expect(current.session.recordings).toHaveLength(2);
    await act(async () => current.session.back());
    expect(container.querySelectorAll(".recording-page__list-row")).toHaveLength(2);
    expect(container.textContent).not.toContain("补充诊断材料");
    expect(invokePlugin).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(recorder.start).toHaveBeenCalledTimes(2);
  });

  it("renames a recording and keeps the title in its list and detail view", async () => {
    await click(pinned);
    await click('.recording-entry-card .recording-bar__button--primary');
    await click('.recording-entry-card .recording-bar__button--primary');
    await act(async () => current.session.back());
    await click('.recording-page__more-trigger');
    await click('.recording-page__more-menu button:has(.lucide-pencil)');
    const field = container.querySelector<HTMLInputElement>('.recording-page__rename input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "企业现场访谈");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
    expect(current.session.recordings[0]!.title).toBe("企业现场访谈");
    await click('.recording-page__list-open');
    expect(container.querySelector('.recording-page__title')?.textContent).toBe("企业现场访谈");
    await act(async () => current.session.back());
    expect(container.querySelector('.recording-page__list-title')?.textContent).toBe("企业现场访谈");
  });

  it("still invokes a material command that shares the capability but has no recording entry", async () => {
    await click('.pinned-command-chip[title="上传材料"]');
    expect(invokePlugin).toHaveBeenCalledTimes(1);
    expect(invokePlugin.mock.calls[0]?.[0].command.command).toBe("/upload");
    expect(current.open).toBe(false);
  });
});
