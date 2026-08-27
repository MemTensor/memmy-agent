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
        alreadyNotifiedVersion: null
      })
    ).toEqual({ silent: false, version: "0.0.2" });
  });

  it("通知声音关闭时返回静音通知", () => {
    expect(
      decideUpdateNotification({
        enabled: true,
        soundEnabled: false,
        status: "available",
        latestVersion: "0.0.2",
        alreadyNotifiedVersion: null
      })
    ).toEqual({ silent: true, version: "0.0.2" });
  });

  it("软件更新通知关闭时不弹通知", () => {
    expect(
      decideUpdateNotification({
        enabled: false,
        soundEnabled: true,
        status: "available",
        latestVersion: "0.0.2",
        alreadyNotifiedVersion: null
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
        alreadyNotifiedVersion: null
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
        alreadyNotifiedVersion: "0.0.2"
      })
    ).toBeNull();
  });

  it("缺少最新版本号时不弹通知", () => {
    expect(
      decideUpdateNotification({
        enabled: true,
        soundEnabled: true,
        status: "available",
        alreadyNotifiedVersion: null
      })
    ).toBeNull();
  });
});
