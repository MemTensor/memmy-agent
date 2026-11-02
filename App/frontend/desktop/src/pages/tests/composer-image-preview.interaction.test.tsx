// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PendingAttachment, PendingImage } from "../../state/agent-composer-state.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ComposerMediaPreviewStrip } from "../home-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("composer image preview interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("opens, navigates, and closes the shared lightbox from pending image cards", () => {
    act(() => root.render(<PreviewHarness />));

    const firstCard = document.querySelector<HTMLElement>('[data-testid="agent-attachment-card-image"]');
    const cardButtons = Array.from(firstCard?.children ?? []).filter((element) => element.tagName === "BUTTON");
    expect(cardButtons).toHaveLength(2);

    act(() => getButton("preview-one.png").click());
    expect(currentLightboxImageName()).toBe("preview-one.png");

    act(() => getButton("Next image").click());
    expect(currentLightboxImageName()).toBe("preview-two.png");

    act(() => getButton("Close").click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps remove independent from preview and closes the lightbox when its image disappears", () => {
    act(() => root.render(<PreviewHarness />));

    act(() => getButton("移除: preview-one.png").click());
    expect(document.querySelector('button[aria-label="preview-one.png"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    act(() => getButton("preview-two.png").click());
    expect(currentLightboxImageName()).toBe("preview-two.png");

    act(() => getButton("移除: preview-two.png").click());
    expect(document.querySelector('button[aria-label="preview-two.png"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("orders image cards and lightbox navigation by addition order around folder references", () => {
    act(() => root.render(
      <I18nProvider language="zh-CN">
        <ComposerMediaPreviewStrip
          items={[
            { ...pendingImage("later", "later.png", "data:image/png;base64,BBBB"), addedOrder: 3 },
            { ...pendingImage("earlier", "earlier.png", "data:image/png;base64,AAAA"), addedOrder: 1 }
          ]}
          references={[{ kind: "path", id: "/tmp/Folder", label: "Folder/", addedOrder: 2 }]}
          onRemove={() => undefined}
        />
      </I18nProvider>
    ));
    expect(Array.from(document.querySelectorAll<HTMLElement>(".composer-media-preview-strip .agent-attachment-card"), (card) => card.title))
      .toEqual(["earlier.png", "/tmp/Folder", "later.png"]);
    act(() => getButton("earlier.png").click());
    expect(currentLightboxImageName()).toBe("earlier.png");
    act(() => getButton("Next image").click());
    expect(currentLightboxImageName()).toBe("later.png");
  });
});

function PreviewHarness() {
  const [items, setItems] = useState<PendingAttachment[]>(() => [
    pendingImage("one", "preview-one.png", "data:image/png;base64,AAAA"),
    pendingImage("two", "preview-two.png", "data:image/png;base64,BBBB")
  ]);
  return (
    <ComposerMediaPreviewStrip
      items={items}
      onRemove={(id) => setItems((current) => current.filter((item) => item.id !== id))}
      removeLabel="移除"
      selectedLabel="已选择媒体"
    />
  );
}

function pendingImage(id: string, fileName: string, previewUrl: string): PendingImage {
  return {
    id,
    sourceKey: id,
    fileName,
    kind: "image",
    previewUrl,
    status: "ready",
    originalBytes: 4,
    encodedBytes: 4,
    encodedMime: "image/png"
  };
}

function getButton(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) {
    throw new Error(`Missing button: ${label}`);
  }
  return button;
}

function currentLightboxImageName(): string | null {
  return document.querySelector<HTMLImageElement>('[role="dialog"] img')?.getAttribute("alt") ?? null;
}
