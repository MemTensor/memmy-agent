/** Open url tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl, openUrl } from "../open-url.js";

type OpenExternal = NonNullable<Window["memmy"]>["openExternal"];

describe("openUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("有 Electron bridge 时优先调用 window.memmy.openExternal", async () => {
    const openExternal = vi.fn<OpenExternal>().mockResolvedValue(undefined);
    const open = vi.fn();
    vi.stubGlobal("window", { memmy: { openExternal }, open });

    await openUrl(" https://example.com/oauth ");

    expect(openExternal).toHaveBeenCalledWith("https://example.com/oauth");
    expect(open).not.toHaveBeenCalled();
  });

  it("没有 Electron bridge 时回退 window.open", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });

    await openUrl("https://example.com/oauth");

    expect(open).toHaveBeenCalledWith("https://example.com/oauth", "_blank", "noopener,noreferrer");
  });

  it("Electron bridge 形状异常时回退 window.open 且不抛", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { memmy: { openExternal: "broken" }, open });

    await expect(openUrl("https://example.com/oauth")).resolves.toBeUndefined();

    expect(open).toHaveBeenCalledWith("https://example.com/oauth", "_blank", "noopener,noreferrer");
  });

  it("Electron bridge 拒绝时回退 window.open", async () => {
    const openExternal = vi.fn<OpenExternal>().mockRejectedValue(new Error("bridge failed"));
    const open = vi.fn();
    vi.stubGlobal("window", { memmy: { openExternal }, open });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await openUrl("https://example.com/oauth");

    expect(openExternal).toHaveBeenCalledWith("https://example.com/oauth");
    expect(open).toHaveBeenCalledWith("https://example.com/oauth", "_blank", "noopener,noreferrer");
    expect(warn).toHaveBeenCalledWith("[tools] openExternal failed; falling back to window.open:", expect.any(Error));
  });

  it("openExternalUrl 是 openUrl 的语义化别名,行为完全一致", async () => {
    expect(openExternalUrl).toBe(openUrl);

    const open = vi.fn();
    vi.stubGlobal("window", { open });

    await openExternalUrl("https://example.com/legal");

    expect(open).toHaveBeenCalledWith("https://example.com/legal", "_blank", "noopener,noreferrer");
  });
});
