// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppProviders } from "../../app/providers.js";
import { useAppState } from "../../state/app-state.js";
import { appActions, type RecordingSidebarStatus } from "../../state/app-actions.js";
import { AppFrame } from "../app-frame.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("sidebar recording shortcuts", () => {
  let root: Root;
  let container: HTMLDivElement;
  function Harness(props: { status: RecordingSidebarStatus; active?: boolean; viewed?: boolean }) {
    const { dispatch } = useAppState();
    useEffect(() => { dispatch(appActions.recordingStatusChanged(props.status)); }, [dispatch, props.status]);
    return <AppFrame title="测试" recordingActive={props.active} recordingViewed={props.viewed}><div /></AppFrame>;
  }
  const render = async (status: RecordingSidebarStatus, active = false, viewed = false) => act(async () => {
    root.render(<AppProviders><Harness status={status} active={active} viewed={viewed} /></AppProviders>);
  });
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it.each(["ready", "failed"] as const)("restores Start after a %s recording is opened or viewed", async (status) => {
    await render(status);
    expect(container.querySelector('.app-frame-recording-nav__post-status--view')).not.toBeNull();
    expect(container.querySelector('.app-frame-recording-nav__control--record')).toBeNull();
    await render(status, true);
    expect(container.querySelector('.app-frame-recording-nav__post-status--view')).toBeNull();
    expect(container.querySelector('.app-frame-recording-nav__control--record')?.textContent).toBe("开始");
    await render(status, false, true);
    expect(container.querySelector('.app-frame-recording-nav__control--record')?.getAttribute('aria-label')).toBe("开始录音");
  });

  it("keeps transcription and active recording controls separate from Start", async () => {
    await render("transcribing", true, true);
    expect(container.querySelector('.app-frame-recording-nav__control--record')).toBeNull();
    await render("recording", true, true);
    expect(container.querySelector('.app-frame-recording-nav__control--record')).toBeNull();
    expect(container.querySelector('.app-frame-recording-nav [aria-label="暂停"]')).not.toBeNull();
    expect(container.querySelector('.app-frame-recording-nav [aria-label="结束并转写"]')).not.toBeNull();
  });
});
