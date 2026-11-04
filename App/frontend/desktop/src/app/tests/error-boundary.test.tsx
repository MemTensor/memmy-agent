// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../error-boundary.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // React logs the caught error itself; keeping that out of the test output
  // is not the same as ignoring it, which the boundary test below checks.
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  errorSpy.mockRestore();
});

/**
 * Throws for as long as `fuse.lit` is true, renders a marker otherwise.
 *
 * The switch is external rather than a render counter on purpose: React 19
 * retries a throwing render once before it commits the error, so a component
 * that only blows up on its first render is quietly rescued by that retry and
 * the boundary is never exercised. A fuse that stays lit is what a real crash
 * looks like — the same bad state on every attempt.
 */
function Bomb(props: { fuse: { lit: boolean } }): ReactNode {
  if (props.fuse.lit) throw new Error("kaboom");
  return <p data-testid="content">rendered</p>;
}

describe("ErrorBoundary", () => {
  it("renders children untouched when nothing throws", () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <p data-testid="content">hello</p>
        </ErrorBoundary>
      );
    });
    expect(container.querySelector("[data-testid=content]")?.textContent).toBe("hello");
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("replaces a blank window with a crash screen that names the error", async () => {
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <Bomb fuse={{ lit: true }} />
        </ErrorBoundary>
      );
    });

    // This is the whole point: before the boundary, a throw here unmounted the
    // tree and left #root empty — a white page with nothing to read.
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(container.querySelector("[data-testid=content]")).toBeNull();

    const detailsToggle = [...container.querySelectorAll("button")].find((button) => /详情|details/i.test(button.textContent ?? ""));
    act(() => detailsToggle?.click());
    expect(container.querySelector("pre")?.textContent).toContain("kaboom");
  });

  it("logs the error and its component stack so the log file can explain a report", async () => {
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <Bomb fuse={{ lit: true }} />
        </ErrorBoundary>
      );
    });
    const boundaryLog = errorSpy.mock.calls.find((call) => String(call[0]).includes("Renderer error boundary caught"));
    expect(boundaryLog).toBeDefined();
    expect(boundaryLog?.[1]).toBeInstanceOf(Error);
    expect(String(boundaryLog?.[2])).toContain("Bomb");
  });

  it("retry remounts the subtree fresh instead of resuming the broken one", async () => {
    const fuse = { lit: true };
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <Bomb fuse={fuse} />
        </ErrorBoundary>
      );
    });
    expect(container.querySelector("[role=alert]")).not.toBeNull();

    // Whatever was wrong has been fixed by the time the user presses retry.
    fuse.lit = false;
    const retry = [...container.querySelectorAll("button")].find((button) => /重试|try again/i.test(button.textContent ?? ""));
    expect(retry).toBeDefined();
    await act(async () => retry?.click());

    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(container.querySelector("[data-testid=content]")?.textContent).toBe("rendered");
  });

  it("does not depend on the app's providers, so a provider that throws is still caught", async () => {
    function BrokenProvider(): ReactNode {
      throw new Error("provider exploded");
    }
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <BrokenProvider />
        </ErrorBoundary>
      );
    });
    expect(container.querySelector("[role=alert]")).not.toBeNull();
  });
});
