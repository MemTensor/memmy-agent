/** Pet guide tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import {
  PET_GUIDE_COMPLETED_STORAGE_KEY,
  CLOSE_MAIN_WINDOW_ACTION_STORAGE_KEY,
  PetGuideModal,
  markPetGuideCompleted,
  readCloseMainWindowAction,
  readPetGuideCompleted,
  resolveCompletedMainWindowAction,
  resolveDeclinedMainWindowAction,
  resolvePetGuideChoice,
  shouldShowPetGuideForMainWindowAction,
  writeCloseMainWindowAction
} from "../pet-guide.js";

describe("PetGuideModal", () => {
  it("完全保留 v2 原型弹窗文案、按钮位置和推荐标", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <PetGuideModal onChoice={() => undefined} />
      </I18nProvider>
    );

    expect(html).toContain("把 Memmy 缩成桌宠陪你？");
    expect(html).toContain("Memmy 会常驻屏幕角落，随时点击即可对话，轻量不打扰。");
    expect(html).toContain("拒绝");
    expect(html).toContain("桌宠模式");
    expect(html).toContain("推荐");
    expect(html).toContain("可在设置「启动与窗口 → 关闭主窗口时」中随时调整");
    expect(html).toContain("max-w-md mx-4 overflow-hidden border border-border-stone/40");
    expect(html).toContain("grid grid-cols-2 gap-3");
    expect(html).toContain("bg-action-sky rounded-btn");
  });
});

describe("pet guide local preferences", () => {
  it("用机器级固定 localStorage key 记录已引导和关闭主窗口行为", () => {
    const storage = createMemoryStorage();

    expect(PET_GUIDE_COMPLETED_STORAGE_KEY).toBe("memmy.petGuide.completed");
    expect(CLOSE_MAIN_WINDOW_ACTION_STORAGE_KEY).toBe("memmy.closeMainWindowAction");
    expect(readPetGuideCompleted(storage)).toBe(false);
    expect(readCloseMainWindowAction(storage)).toBe("tray");

    markPetGuideCompleted(storage);
    writeCloseMainWindowAction(storage, "pet");

    expect(readPetGuideCompleted(storage)).toBe(true);
    expect(readCloseMainWindowAction(storage)).toBe("pet");
  });

  it("接受推荐后工作区关闭或最小化都进入桌宠", () => {
    expect(resolveCompletedMainWindowAction("pet", "close")).toBe("pet");
    expect(resolveCompletedMainWindowAction("pet", "minimize")).toBe("pet");
    expect(resolveCompletedMainWindowAction("quit", "close")).toBe("quit");
    expect(resolveCompletedMainWindowAction("quit", "minimize")).toBe("minimize");
    expect(resolveCompletedMainWindowAction("tray", "close")).toBe("hide");
    expect(resolveCompletedMainWindowAction("tray", "minimize")).toBe("minimize");
    expect(resolveDeclinedMainWindowAction("close")).toBe("close");
    expect(resolveDeclinedMainWindowAction("minimize")).toBe("minimize");
  });

  it("登录入口页首次最小化可以弹出桌宠引导，接受后最小化进入桌宠", () => {
    expect(shouldShowPetGuideForMainWindowAction("login", "minimize", false)).toBe(true);
    expect(shouldShowPetGuideForMainWindowAction("login", "close", false)).toBe(false);
    expect(shouldShowPetGuideForMainWindowAction("login", "minimize", true)).toBe(false);
    expect(resolveCompletedMainWindowAction("pet", "minimize", "login")).toBe("pet");
    expect(resolveCompletedMainWindowAction("tray", "minimize", "login")).toBe("minimize");
    expect(resolveCompletedMainWindowAction("pet", "close", "login")).toBe("quit");
  });

  it("非登录认证页关闭或最小化不会进入桌宠，避免未登录退出卡住", () => {
    expect(shouldShowPetGuideForMainWindowAction("auth", "minimize", false)).toBe(false);
    expect(shouldShowPetGuideForMainWindowAction("auth", "close", false)).toBe(false);
    expect(resolveCompletedMainWindowAction("pet", "minimize", "auth")).toBe("minimize");
    expect(resolveCompletedMainWindowAction("pet", "close", "auth")).toBe("quit");
    expect(resolveCompletedMainWindowAction("tray", "close", "auth")).toBe("quit");
    expect(resolveCompletedMainWindowAction("quit", "close", "auth")).toBe("quit");
    expect(resolveCompletedMainWindowAction("tray", "minimize", "auth")).toBe("minimize");
    expect(resolveCompletedMainWindowAction("quit", "minimize", "auth")).toBe("minimize");
  });

  it("点击桌宠模式会写入缩到桌宠默认行为；点击拒绝不改变默认行为", () => {
    const acceptedStorage = createMemoryStorage();
    const accepted = resolvePetGuideChoice(acceptedStorage, "pet", "close");
    const acceptedMinimizeStorage = createMemoryStorage();
    const acceptedMinimize = resolvePetGuideChoice(acceptedMinimizeStorage, "pet", "minimize");

    expect(accepted).toEqual({ resolution: "pet" });
    expect(readPetGuideCompleted(acceptedStorage)).toBe(true);
    expect(readCloseMainWindowAction(acceptedStorage)).toBe("pet");
    expect(acceptedMinimize).toEqual({ resolution: "pet" });
    expect(readPetGuideCompleted(acceptedMinimizeStorage)).toBe(true);
    expect(readCloseMainWindowAction(acceptedMinimizeStorage)).toBe("pet");

    const loginAcceptedStorage = createMemoryStorage();
    const loginAccepted = resolvePetGuideChoice(loginAcceptedStorage, "pet", "minimize", "login");

    expect(loginAccepted).toEqual({ resolution: "pet" });
    expect(readPetGuideCompleted(loginAcceptedStorage)).toBe(true);
    expect(readCloseMainWindowAction(loginAcceptedStorage)).toBe("pet");

    const authAcceptedStorage = createMemoryStorage();
    const authAccepted = resolvePetGuideChoice(authAcceptedStorage, "pet", "close", "auth");

    expect(authAccepted).toEqual({ resolution: "quit" });
    expect(readPetGuideCompleted(authAcceptedStorage)).toBe(true);
    expect(readCloseMainWindowAction(authAcceptedStorage)).toBe("tray");

    const declinedStorage = createMemoryStorage();
    writeCloseMainWindowAction(declinedStorage, "quit");
    const declinedClose = resolvePetGuideChoice(declinedStorage, "decline", "close");
    const declinedMinimize = resolvePetGuideChoice(declinedStorage, "decline", "minimize");

    expect(declinedClose).toEqual({ resolution: "close" });
    expect(declinedMinimize).toEqual({ resolution: "minimize" });
    expect(readPetGuideCompleted(declinedStorage)).toBe(true);
    expect(readCloseMainWindowAction(declinedStorage)).toBe("quit");
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}
