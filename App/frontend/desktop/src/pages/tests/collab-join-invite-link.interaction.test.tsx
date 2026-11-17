// @vitest-environment happy-dom

/**
 * 浏览器里的邀请链接经 memmy://invite/<code> 拉起桌面端后，加入弹窗带着邀请码打开：
 * 直接预填并预览，用户点开链接就是想加入，不必再粘贴一次。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { JoinProjectModal } from "../collab-join-project-dialog.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = "AbCdEfGhIjKlMnOpQrStUv";

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

function button(label: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label) ?? null;
}

describe("join dialog opened from an invite link", () => {
  let container: HTMLDivElement;
  let root: Root;
  const collab = { previewInvite: vi.fn(), joinProject: vi.fn() };
  const onJoined = vi.fn();
  const onClose = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    collab.previewInvite.mockResolvedValue({
      code: CODE,
      projectId: "cloud-1",
      projectName: "Memmy 开发",
      inviterName: "用户A",
      memberCount: 2,
      memberNames: ["用户A", "用户C"],
      joinMode: "direct",
      status: "none"
    });
    collab.joinProject.mockResolvedValue({ status: "joined", projectId: "cloud-1", project: null });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <JoinProjectModal
            open
            collab={collab as never}
            initialReference={CODE}
            onClose={onClose}
            onJoined={onJoined}
          />
        </I18nProvider>
      );
    });
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("previews the invitation without the person pasting anything", async () => {
    expect(collab.previewInvite).toHaveBeenCalledWith(CODE);
    expect(document.body.textContent).toContain("用户A 邀请你加入项目");
    expect(button("加入项目")).toBeTruthy();
  });

  it("joins with the code that came from the link", async () => {
    await act(async () => button("加入项目")!.click());
    await flush();
    expect(collab.joinProject).toHaveBeenCalledWith(CODE, undefined, undefined);
  });

  /**
   * 昵称是可选字段：不填就沿用账号原来的名字，所以不拦人；填了就当新名字一起交上去。
   */
  it("sends the nickname only when one was typed", async () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="修改昵称"]');
    expect(input).toBeTruthy();
    expect(input!.placeholder).toBe("为了更好地协作，改个方便同事称呼的名字吧");
    expect(document.body.textContent).toContain("可选");

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input!, "  张三  ");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("加入项目")!.click());
    await flush();
    expect(collab.joinProject).toHaveBeenCalledWith(CODE, undefined, "张三");
  });

  /** 重名被云端拦下时，原因写在字段下面，而不是只把弹窗关掉或弹一个不相干的错误。 */
  it("shows why a name was refused under the field itself", async () => {
    collab.joinProject.mockRejectedValue(new Error("本项目已有人叫这个名字"));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="修改昵称"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "快乐锦鲤");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("加入项目")!.click());
    await flush();
    expect(document.body.textContent).toContain("本项目已有人叫这个名字");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
});
