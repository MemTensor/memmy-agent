// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatRendererFailure,
  registerRendererFailureDiagnostics,
  resolveStartupErrorLanguage,
  StartupErrorBoundary,
  StartupErrorScreen
} from "../startup-error-boundary.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("startup failure recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onCaughtError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    onCaughtError = vi.fn();
    root = createRoot(container, { onCaughtError });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("replaces a render failure with a retryable page and reports the React error", () => {
    const retry = vi.fn();
    const failure = new Error("fixture render failure");
    function BrokenChild(): never {
      throw failure;
    }

    act(() => root.render(
      <StartupErrorBoundary language="zh-CN" onRetry={retry}>
        <BrokenChild />
      </StartupErrorBoundary>
    ));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Memmy 启动失败");
    expect(container.textContent).not.toContain(failure.message);
    expect(onCaughtError).toHaveBeenCalledWith(failure, expect.objectContaining({
      componentStack: expect.stringContaining("BrokenChild")
    }));
    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it("preserves a successfully rendered child", () => {
    act(() => root.render(
      <StartupErrorBoundary language="en-US" onRetry={() => undefined}>
        <p>ready</p>
      </StartupErrorBoundary>
    ));
    expect(container.textContent).toBe("ready");
    expect(onCaughtError).not.toHaveBeenCalled();
  });

  it("renders English recovery copy without any app providers", () => {
    const html = renderToString(<StartupErrorScreen language="en-US" onRetry={() => undefined} />);
    expect(html).toContain("Memmy could not start");
    expect(html).toContain("Retry");
    expect(resolveStartupErrorLanguage("en-GB")).toBe("en-US");
    expect(resolveStartupErrorLanguage("zh-TW")).toBe("zh-CN");
  });

  it("keeps actionable stack context while removing credentials and URL query data", () => {
    const failure = new Error("Authorization: Bearer abc123 password=secret-value api_key=key-value");
    failure.stack = `${failure.message}\n at start (https://user:pwd@example.com/app.js?token=url-secret#state:12:3)`;
    const diagnostic = formatRendererFailure(failure, "\n at BrokenChild\n at App");
    expect(diagnostic).toContain("BrokenChild");
    expect(diagnostic).toContain("https://example.com/app.js");
    for (const secret of ["abc123", "secret-value", "key-value", "url-secret", "user:pwd", "#state"]) {
      expect(diagnostic).not.toContain(secret);
    }
    expect(formatRendererFailure({ message: "private payload" })).not.toContain("private payload");
    expect(formatRendererFailure("private prompt")).not.toContain("private prompt");
  });

  it("records global failures without cancelling their default behavior and can remove listeners", () => {
    const report = vi.fn();
    const remove = registerRendererFailureDiagnostics(window, report);
    const failure = new Error("fixture async failure");
    const errorEvent = new ErrorEvent("error", { error: failure, cancelable: true });
    const rejectionEvent = new Event("unhandledrejection", { cancelable: true });
    Object.defineProperty(rejectionEvent, "reason", { value: failure });

    window.dispatchEvent(errorEvent);
    window.dispatchEvent(rejectionEvent);
    expect(report).toHaveBeenCalledWith(failure, "window-error");
    expect(report).toHaveBeenCalledWith(failure, "unhandled-rejection");
    expect(errorEvent.defaultPrevented).toBe(false);
    expect(rejectionEvent.defaultPrevented).toBe(false);

    remove();
    report.mockClear();
    window.dispatchEvent(errorEvent);
    window.dispatchEvent(rejectionEvent);
    expect(report).not.toHaveBeenCalled();
  });
});
