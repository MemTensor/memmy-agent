/** Memory panel error classification tests. */
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../../api/http.js";
import {
  MEMORY_PANEL_RETRY_DELAYS_MS,
  classifyMemoryPanelError,
  memoryPanelErrorTitleKey,
  memoryPanelRetryDelayMs
} from "../memory-panel-error.js";

describe("classifyMemoryPanelError", () => {
  it("treats memory_layer_unavailable as a retryable outage", () => {
    const info = classifyMemoryPanelError(
      new ApiRequestError("memory layer network error", 503, "memory_layer_unavailable", "req-1")
    );

    expect(info).toMatchObject({
      kind: "unavailable",
      retryable: true,
      requestId: "req-1",
      detail: "memory layer network error"
    });
  });

  it("treats a bare fetch TypeError as a transient outage", () => {
    const info = classifyMemoryPanelError(new TypeError("Failed to fetch"));

    expect(info.kind).toBe("unavailable");
    expect(info.retryable).toBe(true);
  });

  it("does not retry authentication failures", () => {
    const info = classifyMemoryPanelError(new ApiRequestError("bad token", 401, "unauthorized", "req-2"));

    expect(info.kind).toBe("unauthorized");
    expect(info.retryable).toBe(false);
  });

  it("separates a missing client from a service outage", () => {
    const info = classifyMemoryPanelError(new Error("client missing"), false);

    expect(info.kind).toBe("not-ready");
    expect(info.retryable).toBe(false);
    expect(memoryPanelErrorTitleKey(info)).toBe("memory.clientNotReady");
  });

  it("maps each kind to its own actionable headline", () => {
    expect(memoryPanelErrorTitleKey({ kind: "unavailable", detail: "", requestId: null, retryable: true }))
      .toBe("memory.panelError.unavailable");
    expect(memoryPanelErrorTitleKey({ kind: "unauthorized", detail: "", requestId: null, retryable: false }))
      .toBe("memory.panelError.unauthorized");
    expect(memoryPanelErrorTitleKey({ kind: "unknown", detail: "", requestId: null, retryable: false }))
      .toBe("memory.panelError.generic");
  });
});

describe("memoryPanelRetryDelayMs", () => {
  it("walks the backoff schedule then stops", () => {
    expect(memoryPanelRetryDelayMs(0)).toBe(MEMORY_PANEL_RETRY_DELAYS_MS[0]);
    expect(memoryPanelRetryDelayMs(MEMORY_PANEL_RETRY_DELAYS_MS.length - 1))
      .toBe(MEMORY_PANEL_RETRY_DELAYS_MS[MEMORY_PANEL_RETRY_DELAYS_MS.length - 1]);
    expect(memoryPanelRetryDelayMs(MEMORY_PANEL_RETRY_DELAYS_MS.length)).toBeNull();
  });

  it("rejects negative and non-integer attempt indexes", () => {
    expect(memoryPanelRetryDelayMs(-1)).toBeNull();
    expect(memoryPanelRetryDelayMs(1.5)).toBeNull();
  });
});
