// @vitest-environment happy-dom

/** Modal tests. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Modal, shouldCloseModalByBackdrop, shouldCloseModalByKey, shouldInitializeModalFocus } from "../modal.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Modal", () => {
  it("renders a centered dialog without right-side drawer classes", () => {
    const html = renderToString(
      <Modal open title="Center modal">
        <p>Body</p>
      </Modal>
    );

    expect(html).toContain('class="modal-backdrop"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).not.toContain("modal-right");
    expect(html).not.toContain("modal-placement-right");
  });

  it("can hide the header while keeping an accessible label", () => {
    const html = renderToString(
      <Modal open title="Hidden title" showHeader={false} ariaLabel="Hidden title">
        <p>Body</p>
      </Modal>
    );

    expect(html).toContain('aria-label="Hidden title"');
    expect(html).not.toContain("<header");
    expect(html).not.toContain("<h2");
  });

  it("allows custom close button content", () => {
    const html = renderToString(
      <Modal open title="Center modal" closeLabel="关闭" closeContent={<span data-testid="close-icon">x</span>} onClose={() => undefined}>
        <p>Body</p>
      </Modal>
    );

    expect(html).toContain('aria-label="关闭"');
    expect(html).toContain('data-testid="close-icon"');
  });

  it("allows a scoped backdrop class without replacing modal-backdrop", () => {
    const html = renderToString(
      <Modal open title="Center modal" backdropClassName="rename-dialog-backdrop">
        <p>Body</p>
      </Modal>
    );

    expect(html).toContain('class="modal-backdrop rename-dialog-backdrop"');
  });

  it("can keep backdrop and Escape close behavior without rendering a header close button", () => {
    const html = renderToString(
      <Modal open title="Confirm title" showCloseButton={false} onClose={() => undefined}>
        <p>Body</p>
      </Modal>
    );

    expect(html).toContain("<h2");
    expect(html).toContain("Confirm title");
    expect(html).not.toContain('aria-label="Close"');
    expect(html).not.toContain(">Close</button>");
  });

  it("treats Escape as a close key", () => {
    expect(shouldCloseModalByKey("Escape")).toBe(true);
    expect(shouldCloseModalByKey("Enter")).toBe(false);
  });

  it("initializes focus only when the modal opens", () => {
    expect(shouldInitializeModalFocus(false, true)).toBe(true);
    expect(shouldInitializeModalFocus(true, true)).toBe(false);
    expect(shouldInitializeModalFocus(true, false)).toBe(false);
    expect(shouldInitializeModalFocus(false, false)).toBe(false);
  });

  it("only treats direct backdrop clicks as close requests", () => {
    const backdrop = {};

    expect(shouldCloseModalByBackdrop({ target: backdrop, currentTarget: backdrop } as never)).toBe(true);
    expect(shouldCloseModalByBackdrop({ target: {}, currentTarget: backdrop } as never)).toBe(false);
  });

  it("does not close when a text-selection drag starts inside the modal and ends on the backdrop", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onClose = vi.fn();
    document.body.append(container);

    try {
      act(() => root.render(
        <Modal open title="Model configuration" onClose={onClose}>
          <span>gpt-5.4</span>
        </Modal>
      ));

      const backdrop = container.querySelector<HTMLElement>(".modal-backdrop")!;
      const modelId = container.querySelector<HTMLElement>(".modal-body span")!;

      act(() => {
        modelId.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        backdrop.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onClose).not.toHaveBeenCalled();

      act(() => {
        backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        modelId.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onClose).not.toHaveBeenCalled();

      act(() => {
        backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        backdrop.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
