// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePanelLoad } from "../use-panel-load.js";
import { usePanelPoll } from "../use-panel-poll.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("panel loading lifecycle", () => {
  it("loads entry and pages immediately, debounces only search and submits once", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const root = createRoot(container);
    const load = vi.fn(async (_query: string, _page: number) => undefined);
    const invalidate = vi.fn();
    let changeQuery!: (query: string) => void;
    let changePage!: (page: number) => void;
    let submit!: () => void;
    function Fixture() {
      const [query, setQuery] = useState("");
      const [page, setPage] = useState(1);
      const search = usePanelLoad({ query, identity: [page], load: () => load(query, page), invalidate });
      changeQuery = (value) => {
        setQuery(value);
        setPage(1);
      };
      changePage = setPage;
      submit = () => {
        setPage(1);
        void search(() => load(query, 1), [1]);
      };
      return null;
    }
    await act(async () => root.render(<Fixture />));
    expect(load.mock.calls).toEqual([["", 1]]);
    await act(async () => changePage(2));
    expect(load).toHaveBeenLastCalledWith("", 2);
    await act(async () => changeQuery("needle"));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => submit());
    await act(async () => vi.advanceTimersByTime(200));
    expect(load.mock.calls).toEqual([
      ["", 1],
      ["", 2],
      ["needle", 1]
    ]);
    await act(async () => changePage(2));
    await act(async () => submit());
    await act(async () => vi.advanceTimersByTime(200));
    expect(load.mock.calls.slice(-2)).toEqual([
      ["needle", 2],
      ["needle", 1]
    ]);
    const beforeUnmount = invalidate.mock.calls.length;
    await act(async () => root.unmount());
    expect(invalidate.mock.calls.length).toBeGreaterThan(beforeUnmount);
  });

  it("waits for slow polls, backs off after failure, and resumes once after becoming visible", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const root = createRoot(container);
    let finish!: () => void;
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const visibility = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    function Fixture() {
      usePanelPoll(true, load, 1000);
      return null;
    }
    await act(async () => root.render(<Fixture />));
    await act(async () => vi.advanceTimersByTime(5000));
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await act(async () => {
      visibility.mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => vi.advanceTimersByTime(5000));
    expect(load).toHaveBeenCalledTimes(1);
    load.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    await act(async () => {
      visibility.mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1999));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(load).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount());
    visibility.mockRestore();
  });
});
