// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PdfPreview } from "../file-preview/pdf-preview.js";

const controls = vi.hoisted(() => {
  const tasks: Array<{
    promise: Promise<unknown>;
    destroy: ReturnType<typeof vi.fn>;
    resolveLoading(value: unknown): void;
    rejectLoading(error: Error): void;
    resolveDestroy(): void;
    rejectDestroy(error: Error): void;
  }> = [];
  const wrappers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const ports: Array<{ terminate: ReturnType<typeof vi.fn> }> = [];
  const getDocument = vi.fn(() => {
    let resolveLoading!: (value: unknown) => void;
    let rejectLoading!: (error: Error) => void;
    let resolveDestroy!: () => void;
    let rejectDestroy!: (error: Error) => void;
    const promise = new Promise<unknown>((resolve, reject) => { resolveLoading = resolve; rejectLoading = reject; });
    const destroyed = new Promise<void>((resolve, reject) => { resolveDestroy = resolve; rejectDestroy = reject; });
    const task = { promise, destroy: vi.fn(() => destroyed),
      resolveLoading, rejectLoading, resolveDestroy, rejectDestroy };
    tasks.push(task);
    return task;
  });
  const createWorker = vi.fn(() => {
    const wrapper = { destroy: vi.fn() };
    wrappers.push(wrapper);
    return wrapper;
  });
  return { tasks, wrappers, ports, getDocument, createWorker };
});

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {}, PDFWorker: { create: controls.createWorker },
  getDocument: controls.getDocument, TextLayer: vi.fn(),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/fixture-pdf-worker.mjs" }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?worker", () => ({ default: class {
  terminate = vi.fn();
  constructor() { controls.ports.push(this); }
} }));

describe("PDF preview Worker ownership", () => {
  let root: Root | null;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    controls.tasks.length = 0;
    controls.wrappers.length = 0;
    controls.ports.length = 0;
    controls.getDocument.mockClear();
    controls.createWorker.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      root = null;
      for (const task of controls.tasks) task.resolveDestroy();
      await Promise.resolve();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  const show = async (data = new ArrayBuffer(1)) => {
    await act(async () => { root!.render(<I18nProvider language="en-US"><PdfPreview data={data} /></I18nProvider>); });
  };
  const unmount = async () => {
    await act(async () => { root!.unmount(); root = null; });
  };
  const settleDestroy = async (index: number, error?: Error) => {
    await act(async () => {
      if (error) controls.tasks[index]!.rejectDestroy(error);
      else controls.tasks[index]!.resolveDestroy();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };

  it("waits for document shutdown before releasing the external wrapper and port on unmount", async () => {
    await show();
    await unmount();
    expect(controls.tasks[0]!.destroy).toHaveBeenCalledOnce();
    expect.soft(controls.wrappers[0]!.destroy).not.toHaveBeenCalled();
    expect(controls.ports[0]!.terminate).not.toHaveBeenCalled();
    await settleDestroy(0);
    expect(controls.wrappers[0]!.destroy).toHaveBeenCalledOnce();
    expect(controls.ports[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("cleans each data generation once even when an old load succeeds after replacement", async () => {
    await show(new ArrayBuffer(1));
    await show(new ArrayBuffer(2));
    expect(controls.tasks).toHaveLength(2);
    expect(controls.tasks[0]!.destroy).toHaveBeenCalledOnce();
    await act(async () => {
      controls.tasks[0]!.resolveLoading({ loadingTask: controls.tasks[0] });
      await Promise.resolve();
    });
    expect(controls.tasks[0]!.destroy).toHaveBeenCalledOnce();
    await settleDestroy(0);
    expect(controls.ports[0]!.terminate).toHaveBeenCalledOnce();
    expect(controls.ports[1]!.terminate).not.toHaveBeenCalled();
    await unmount();
    await settleDestroy(1);
    expect(controls.tasks[1]!.destroy).toHaveBeenCalledOnce();
    for (const wrapper of controls.wrappers) expect(wrapper.destroy).toHaveBeenCalledOnce();
    for (const port of controls.ports) expect(port.terminate).toHaveBeenCalledOnce();
  });

  it("releases a successfully loaded document's owned resources on unmount", async () => {
    await show();
    await act(async () => {
      controls.tasks[0]!.resolveLoading({ numPages: 1, loadingTask: controls.tasks[0],
        getPage: () => new Promise(() => {}) });
    });
    expect(controls.ports[0]!.terminate).not.toHaveBeenCalled();
    await unmount();
    await settleDestroy(0);
    expect(controls.tasks[0]!.destroy).toHaveBeenCalledOnce();
    expect(controls.wrappers[0]!.destroy).toHaveBeenCalledOnce();
    expect(controls.ports[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("releases a failed load without waiting for its error view to unmount", async () => {
    await show();
    await act(async () => { controls.tasks[0]!.rejectLoading(new Error("Invalid PDF")); });
    expect(controls.tasks[0]!.destroy).toHaveBeenCalledOnce();
    expect(controls.ports[0]!.terminate).not.toHaveBeenCalled();
    await settleDestroy(0);
    await unmount();
    expect(controls.tasks[0]!.destroy).toHaveBeenCalledOnce();
    expect(controls.wrappers[0]!.destroy).toHaveBeenCalledOnce();
    expect(controls.ports[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("still releases the wrapper and port when asynchronous document shutdown rejects", async () => {
    await show();
    await unmount();
    await settleDestroy(0, new Error("Document shutdown failed"));
    expect(controls.tasks[0]!.destroy).toHaveBeenCalledOnce();
    expect(controls.wrappers[0]!.destroy).toHaveBeenCalledOnce();
    expect(controls.ports[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("contains synchronous document shutdown failures and still releases its owned resources", async () => {
    await show();
    controls.tasks[0]!.destroy.mockImplementationOnce(() => { throw new Error("Synchronous shutdown failure"); });
    await unmount();
    expect(controls.tasks[0]!.destroy).toHaveBeenCalledOnce();
    expect(controls.wrappers[0]!.destroy).toHaveBeenCalledOnce();
    expect(controls.ports[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("terminates the port even if wrapper cleanup throws", async () => {
    await show();
    controls.wrappers[0]!.destroy.mockImplementationOnce(() => { throw new Error("Wrapper shutdown failure"); });
    await unmount();
    await settleDestroy(0);
    expect(controls.wrappers[0]!.destroy).toHaveBeenCalledOnce();
    expect(controls.ports[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("releases the created wrapper and port when document initialization throws", async () => {
    controls.getDocument.mockImplementationOnce(() => { throw new Error("Document initialization failed"); });
    await show();
    await unmount();
    expect(controls.wrappers[0]!.destroy).toHaveBeenCalledOnce();
    expect(controls.ports[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("releases its port when wrapper construction fails", async () => {
    controls.createWorker.mockImplementationOnce(() => { throw new Error("Worker initialization failed"); });
    await show();
    await unmount();
    expect(controls.tasks).toHaveLength(0);
    expect(controls.ports[0]!.terminate).toHaveBeenCalledOnce();
  });
});
