import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TaskDoneNotificationDeduplicator } from "../src/main/task-done-notification-deduplicator.js";

describe("task delivery notification deduplication", () => {
  it("guards task notifications in the main process without deduplicating update notifications", () => {
    const main = readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
    const taskNotification = main.slice(main.indexOf("function showTaskDoneNotification("), main.indexOf("function showUpdateAvailableNotification("));
    expect(taskNotification).toContain("!Notification.isSupported() || !taskDoneNotificationDeduplicator.shouldNotify(payload.deliveryId)");
    expect(taskNotification).toContain("showDesktopNotification({ title: payload.title, body: payload.body, silent: payload.silent });");
    const updateNotification = main.slice(main.indexOf("function showUpdateAvailableNotification("), main.indexOf("function showDesktopNotification("));
    expect(updateNotification).not.toContain("shouldNotify");
    expect(updateNotification).toContain("showDesktopNotification(payload);");
    const preload = readFileSync(new URL("../src/preload/preload.cts", import.meta.url), "utf8");
    expect(preload).toContain("async notifyTaskDone(payload: { title: string; body: string; silent: boolean; deliveryId?: string })");
  });

  it("notifies once when multiple windows report the same scheduled delivery", () => {
    const deduplicator = new TaskDoneNotificationDeduplicator();
    expect(deduplicator.shouldNotify("cron:job:1000:message-a")).toBe(true);
    expect(deduplicator.shouldNotify("cron:job:1000:message-a")).toBe(false);
    expect(deduplicator.shouldNotify("cron:job:2000:message-b")).toBe(true);
    expect(deduplicator.shouldNotify("cron:job:2000:message-b")).toBe(false);
  });

  it("preserves ordinary completion notifications without a delivery ID", () => {
    const deduplicator = new TaskDoneNotificationDeduplicator();
    expect(deduplicator.shouldNotify()).toBe(true);
    expect(deduplicator.shouldNotify()).toBe(true);
    expect(deduplicator.shouldNotify("")).toBe(true);
    expect(deduplicator.shouldNotify("  ")).toBe(true);
  });

  it("expires old delivery IDs without extending their lifetime on duplicate attempts", () => {
    let now = 1000;
    const deduplicator = new TaskDoneNotificationDeduplicator({ now: () => now, retentionMs: 100 });
    expect(deduplicator.shouldNotify("delivery-a")).toBe(true);
    now = 1099;
    expect(deduplicator.shouldNotify("delivery-a")).toBe(false);
    now = 1100;
    expect(deduplicator.shouldNotify("delivery-a")).toBe(true);
  });

  it("bounds memory by evicting the oldest delivery IDs", () => {
    const deduplicator = new TaskDoneNotificationDeduplicator({ maxEntries: 2 });
    for (const id of ["a", "b", "c"]) expect(deduplicator.shouldNotify(id)).toBe(true);
    expect(deduplicator.shouldNotify("b")).toBe(false);
    expect(deduplicator.shouldNotify("c")).toBe(false);
    expect(deduplicator.shouldNotify("a")).toBe(true);
    expect(deduplicator.shouldNotify("a")).toBe(false);
  });
});
