/** Task done notification tests. */
import { describe, expect, it } from "vitest";
import { decideTaskDoneNotification } from "../task-done-notification.js";

describe("decideTaskDoneNotification", () => {
  it("窗口未聚焦且开关开启时返回带声音的通知", () => {
    expect(
      decideTaskDoneNotification({ enabled: true, soundEnabled: true, windowFocused: false })
    ).toEqual({ silent: false });
  });

  it("通知声音关闭时返回静音通知", () => {
    expect(
      decideTaskDoneNotification({ enabled: true, soundEnabled: false, windowFocused: false })
    ).toEqual({ silent: true });
  });

  it("任务完成通知关闭时不弹通知", () => {
    expect(
      decideTaskDoneNotification({ enabled: false, soundEnabled: true, windowFocused: false })
    ).toBeNull();
  });

  it("窗口处于聚焦状态时不弹通知", () => {
    expect(
      decideTaskDoneNotification({ enabled: true, soundEnabled: true, windowFocused: true })
    ).toBeNull();
  });
});
