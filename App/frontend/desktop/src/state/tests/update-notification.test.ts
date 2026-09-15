/** Update notification tests. */
import { describe, expect, it } from "vitest";
import { decideUpdateNotification } from "../update-notification.js";

describe("decideUpdateNotification", () => {
  it("有新版本且开关开启时返回带声音的通知", () => {
    expect(
      decideUpdateNotification({
        enabled: true,
        soundEnabled: true,
        status: "available",
        latestVersion: "0.0.2",
        alreadyNotifiedKey: null
      })
    ).toEqual({ key: "0.0.2", silent: false, version: "0.0.2" });
  });

  it("通知声音关闭时返回静音通知", () => {
    expect(
      decideUpdateNotification({
        enabled: true,
        soundEnabled: false,
        status: "available",
        latestVersion: "0.0.2",
        alreadyNotifiedKey: null
      })
    ).toEqual({ key: "0.0.2", silent: true, version: "0.0.2" });
  });

  it("软件更新通知关闭时不弹通知", () => {
    expect(
      decideUpdateNotification({
        enabled: false,
        soundEnabled: true,
        status: "available",
        latestVersion: "0.0.2",
        alreadyNotifiedKey: null
      })
    ).toBeNull();
  });

  it("已是最新版本（非 available）时不弹通知", () => {
    expect(
      decideUpdateNotification({
        enabled: true,
        soundEnabled: true,
        status: "latest",
        latestVersion: "0.0.1",
        alreadyNotifiedKey: null
      })
    ).toBeNull();
  });

  it("同一版本已通知过时不重复弹通知", () => {
    expect(
      decideUpdateNotification({
        enabled: true,
        soundEnabled: true,
        status: "available",
        latestVersion: "0.0.2",
        alreadyNotifiedKey: "0.0.2"
      })
    ).toBeNull();
  });

  it("缺少最新版本号时不弹通知", () => {
    expect(
      decideUpdateNotification({
        enabled: true,
        soundEnabled: true,
        status: "available",
        alreadyNotifiedKey: null
      })
    ).toBeNull();
  });

  it("Store 未提供目标版本时按包基线键通知且不会重复", () => {
    expect(
      decideUpdateNotification({
        enabled: true,
        soundEnabled: true,
        status: "available",
        notificationKey: "Memtensor.Memmy_1.1.1.0_x64__eyack96k521x2",
        alreadyNotifiedKey: null
      })
    ).toEqual({
      key: "Memtensor.Memmy_1.1.1.0_x64__eyack96k521x2",
      silent: false
    });

    expect(
      decideUpdateNotification({
        enabled: true,
        soundEnabled: true,
        status: "available",
        notificationKey: "Memtensor.Memmy_1.1.1.0_x64__eyack96k521x2",
        alreadyNotifiedKey: "Memtensor.Memmy_1.1.1.0_x64__eyack96k521x2"
      })
    ).toBeNull();
  });
});
