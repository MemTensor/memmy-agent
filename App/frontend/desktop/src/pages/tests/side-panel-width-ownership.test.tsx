// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { WorkspaceArtifactPanel } from "../workspace-artifact-panel.js";
import { InterviewRecordingPanel } from "../interview-recording-panel.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const scope = { kind: "session", key: "websocket:width-ownership" } as const;
const loadDirectory = async () => ({ root: { kind: "session" as const, label: "诊断" }, path: "", entries: [], truncated: false });
const loadFile = async () => new Blob();

it("lets only the visible file or recording pane position the conversation controls", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key), clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; }
  } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const recordedWidths = vi.fn();
  function Layout() {
    const [pane, setPane] = useState<"files" | "recording" | "none">("files");
    const [rowWidth, setRowWidth] = useState(1200);
    const [reportedWidth, setReportedWidth] = useState(0);
    const onWidthChange = (width: number) => { recordedWidths(width); setReportedWidth(width); };
    return <>
      <button data-pane="files" onClick={() => setPane("files")}>Files</button>
      <button data-pane="recording" onClick={() => setPane("recording")}>Recording</button>
      <button data-pane="none" onClick={() => setPane("none")}>Close</button>
      <button data-resize onClick={() => setRowWidth(800)}>Narrow</button>
      <button data-widen onClick={() => setRowWidth(1200)}>Wide</button>
      <output data-width>{reportedWidth}</output>
      <WorkspaceArtifactPanel hidden={pane !== "files"} scope={scope} rootLabel="诊断"
        loadDirectory={loadDirectory} loadFile={loadFile} onAddToChat={() => undefined}
        sharedRowWidth={rowWidth} sharedRowReservedWidth={480} onWidthChange={onWidthChange} />
      <InterviewRecordingPanel hidden={pane !== "recording"} session={null}
        sharedRowWidth={rowWidth} sharedRowReservedWidth={480} onWidthChange={onWidthChange} />
    </>;
  }
  const width = () => Number(container.querySelector("[data-width]")!.textContent);
  const click = (selector: string) => act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
  try {
    await act(async () => root.render(<I18nProvider language="zh-CN"><Layout /></I18nProvider>));
    expect(width()).toBe(520);
    expect(recordedWidths.mock.calls.every(([value]) => value === 520)).toBe(true);
    await click('[data-pane="recording"]');
    expect(width()).toBe(480);
    await click('[data-pane="files"]');
    expect(width()).toBe(520);
    recordedWidths.mockClear();
    await click("[data-resize]");
    expect(width()).toBe(320);
    expect(recordedWidths.mock.calls.every(([value]) => value === 320)).toBe(true);
    recordedWidths.mockClear();
    await click('[data-pane="none"]');
    await click("[data-widen]");
    expect(recordedWidths).not.toHaveBeenCalled();
    expect(width()).toBe(320);
    await click('[data-pane="recording"]');
    expect(width()).toBe(480);
    expect(recordedWidths).toHaveBeenCalledWith(480);
    await click('[data-pane="files"]');
    expect(width()).toBe(520);
  } finally {
    act(() => root.unmount()); container.remove();
    if (originalStorage) Object.defineProperty(window, "localStorage", originalStorage);
    else Reflect.deleteProperty(window, "localStorage");
  }
});
