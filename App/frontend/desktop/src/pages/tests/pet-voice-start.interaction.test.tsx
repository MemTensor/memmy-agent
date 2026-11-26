// @vitest-environment happy-dom

import type { AsrSession } from "@memmy/local-api-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AsrClient } from "../../api/asr-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { TaskBusProvider, useTaskBus } from "../../lib/task-bus.js";
import { PetPageView } from "../pet-page.js";

vi.mock("../../components/mascot/pet-idle/pet-idle-animation.js", () => ({ PetIdleAnimation: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestRecorder {
  static isTypeSupported() { return true; }
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  start() { this.state = "recording"; }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
  requestData() { this.ondataavailable?.({ data: new Blob(["test audio"]) }); }
  stop() { this.state = "inactive"; this.onstop?.(); }
}

function deferredPrepare() {
  let resolve!: (session: AsrSession) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AsrSession>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe("pet voice recording startup", () => {
  const trackStop = vi.fn();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }));
  const submit = vi.fn();
  const client = {
    prepare: vi.fn<AsrClient["prepare"]>(),
    release: vi.fn<AsrClient["release"]>().mockResolvedValue(undefined),
    openStream: vi.fn<AsrClient["openStream"]>(),
    transcribe: vi.fn<AsrClient["transcribe"]>().mockResolvedValue({
      text: "test transcript", modelId: "test", provider: "dashscope", source: "byok", transcribedAt: new Date(0).toISOString()
    })
  };
  const oldSession = { transport: "websocket" as const, sessionId: "00000000-0000-4000-8000-000000000001" };
  let root: Root;
  let container: HTMLDivElement;
  let mascotClicks: number;

  function Pet() {
    return <PetPageView bus={useTaskBus()} asrClient={client} onNavigate={vi.fn()} onSubmitTask={submit} />;
  }

  function button(title: string) {
    return container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  }

  function clickMascot() {
    // Click at separate positions so reopening never triggers the double-click shortcut.
    const mascot = container.querySelector<HTMLElement>(".cursor-grab")!;
    act(() => { mascot.dispatchEvent(new MouseEvent("click", { bubbles: true, screenX: ++mascotClicks * 50 })); });
  }

  function escape() {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.stubGlobal("MediaRecorder", TestRecorder);
    vi.stubGlobal("navigator", Object.create(navigator, { mediaDevices: { value: { getUserMedia } } }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mascotClicks = 0;
    act(() => root.render(<I18nProvider language="zh-CN"><TaskBusProvider><Pet /></TaskBusProvider></I18nProvider>));
    clickMascot();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the reopened pet idle and releases a session prepared after Escape", async () => {
    const old = deferredPrepare();
    client.prepare.mockReturnValueOnce(old.promise);
    act(() => button("点击说话")!.click());
    act(escape);
    await act(async () => old.resolve(oldSession));
    clickMascot();

    expect(client.release).toHaveBeenCalledExactlyOnceWith(oldSession.sessionId);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(button("点击说话")).not.toBeNull();
    expect(button("暂停录音")).toBeNull();
    expect(button("结束并发送")).toBeNull();
  });

  it("preserves the replacement recording's pause state and sends its transcript after an old prepare fails", async () => {
    const old = deferredPrepare();
    client.prepare.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ transport: "http" });
    act(() => button("点击说话")!.click());
    act(escape);
    clickMascot();
    await act(async () => button("点击说话")!.click());
    act(() => button("暂停录音")!.click());
    await act(async () => old.reject(new Error("old startup failed")));

    expect(button("继续录音")).not.toBeNull();
    expect(getUserMedia).toHaveBeenCalledOnce();
    act(() => button("继续录音")!.click());
    expect(button("暂停录音")).not.toBeNull();
    await act(async () => {
      button("结束并发送")!.click();
      await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    });
    expect(submit).toHaveBeenCalledWith(expect.anything(), "test transcript");
    expect(client.transcribe).toHaveBeenCalledOnce();
    expect(trackStop).toHaveBeenCalledOnce();
  });

  it("discards a start error when Escape runs between recorder failure and pet error handling", async () => {
    const pending = deferredPrepare();
    client.prepare.mockReturnValueOnce(pending.promise);
    act(() => button("点击说话")!.click());
    await act(async () => {
      pending.reject(new Error("old startup failed"));
      await Promise.resolve();
      escape();
    });
    clickMascot();
    expect(container.querySelector("input")?.value).toBe("");
    expect(button("点击说话")).not.toBeNull();
  });

  it("ignores a repeated start during prepare and displays a current start failure", async () => {
    const pending = deferredPrepare();
    client.prepare.mockReturnValueOnce(pending.promise);
    act(() => button("点击说话")!.click());
    act(() => button("点击说话")!.click());
    expect(client.prepare).toHaveBeenCalledOnce();
    await act(async () => pending.reject(new Error("current startup failed")));

    expect(container.querySelector("input")?.value).toContain("current startup failed");
    expect(button("点击说话")).not.toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("releases a delayed session after unmount without opening the microphone", async () => {
    const pending = deferredPrepare();
    client.prepare.mockReturnValueOnce(pending.promise);
    act(() => button("点击说话")!.click());
    act(() => root.render(null));
    await act(async () => pending.resolve(oldSession));

    expect(client.release).toHaveBeenCalledExactlyOnceWith(oldSession.sessionId);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
