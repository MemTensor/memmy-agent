/** Nickname tests. */
import { describe, expect, it, vi } from "vitest";
import {
  buildAccountNicknameUpdate,
  persistNickname,
  readLocalNickname,
  resolveSubmittedNickname,
  writeLocalNickname
} from "../nickname.js";

const current = {
  email: "grace@example.com",
  phoneNumber: null,
  nickname: "旧昵称",
  registeredAt: "2026-04-12T00:00:00.000Z"
};

describe("nickname 公共逻辑", () => {
  it("空输入回退随机昵称，非空去空白后原样使用", () => {
    expect(resolveSubmittedNickname("  幸运锦鲤 ", "zh-CN")).toBe("幸运锦鲤");
    const fallback = resolveSubmittedNickname("   ", "zh-CN");
    expect(fallback.trim().length).toBeGreaterThan(0);
  });

  it("BYOK 本地昵称写入 localStorage 并可读回，空串视为无记录", () => {
    const storage = new MapStorage();
    expect(readLocalNickname(storage)).toBeNull();
    writeLocalNickname(storage, "元气团子");
    expect(readLocalNickname(storage)).toBe("元气团子");
    storage.setItem("memmy.localNickname", "   ");
    expect(readLocalNickname(storage)).toBeNull();
  });

  it("构造 accountUpdated 载荷：云端资料缺字段时回退当前快照", () => {
    expect(buildAccountNicknameUpdate("新昵称", { nickname: "云端昵称" }, current)).toEqual({
      email: "grace@example.com",
      phoneNumber: null,
      nickname: "云端昵称",
      registeredAt: "2026-04-12T00:00:00.000Z"
    });
    expect(buildAccountNicknameUpdate("新昵称", null, current).nickname).toBe("新昵称");
  });

  it("BYOK 模式提交昵称落本地、不调用 updateProfile", async () => {
    const storage = new MapStorage();
    const updateProfile = vi.fn();
    const update = await persistNickname({
      rawNickname: "顺心橘子",
      language: "zh-CN",
      isByok: true,
      storage,
      current,
      updateProfile
    });

    expect(updateProfile).not.toHaveBeenCalled();
    expect(readLocalNickname(storage)).toBe("顺心橘子");
    expect(update.nickname).toBe("顺心橘子");
  });

  it("账号模式提交昵称走 updateProfile、不落本地", async () => {
    const storage = new MapStorage();
    const updateProfile = vi.fn(async (nickname: string) => ({ nickname }));
    const update = await persistNickname({
      rawNickname: "明朗白鹤",
      language: "zh-CN",
      isByok: false,
      storage,
      current,
      updateProfile
    });

    expect(updateProfile).toHaveBeenCalledWith("明朗白鹤");
    expect(readLocalNickname(storage)).toBeNull();
    expect(update.nickname).toBe("明朗白鹤");
  });

  it("账号模式 updateProfile 失败时回退最终昵称，不抛错", async () => {
    const update = await persistNickname({
      rawNickname: "灵动松鼠",
      language: "zh-CN",
      isByok: false,
      storage: new MapStorage(),
      current,
      updateProfile: async () => {
        throw new Error("network down");
      }
    });

    expect(update.nickname).toBe("灵动松鼠");
    expect(update.email).toBe("grace@example.com");
  });
});

class MapStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}
