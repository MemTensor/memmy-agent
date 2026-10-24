import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronNotificationOutbox, type CronNotificationPayload } from "../../../src/integrations/channels/cron-notification-outbox.js";

const roots: string[] = [];

function storePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-cron-outbox-"));
  roots.push(root);
  return path.join(root, "webui", "pending-cron-notifications.json");
}

function payload(deliveryId = "cron:job:1791806700000"): CronNotificationPayload {
  return {
    deliveryId,
    event: "message",
    chat_id: "chat-test",
    text: "暂无微信新消息",
    metadata: { proactiveDelivery: "cron", cronDeliveryId: deliveryId, scheduledForMs: 1791806700000 },
  };
}

function writeFixture(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CronNotificationOutbox", () => {
  it("loads lazily and leaves a missing store untouched until a notification is queued", () => {
    const file = storePath();
    const outbox = new CronNotificationOutbox(file);

    expect(fs.existsSync(path.dirname(file))).toBe(false);
    expect(outbox.list()).toEqual([]);
    expect(outbox.remove("missing")).toBe(false);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    outbox.enqueue(payload());
    expect(fs.existsSync(file)).toBe(true);
  });

  it("recovers the complete notification and stable delivery ID in a later instance", () => {
    const file = storePath();
    const notification = payload();
    new CronNotificationOutbox(file).enqueue(notification);

    expect(new CronNotificationOutbox(file).list()).toEqual([notification]);
  });

  it("upserts an existing ID without creating a duplicate or moving it behind later notifications", () => {
    const outbox = new CronNotificationOutbox(storePath());
    outbox.enqueue(payload("first"));
    outbox.enqueue(payload("second"));
    outbox.enqueue({ ...payload("first"), text: "updated result" });

    expect(outbox.list().map(({ deliveryId, text }) => ({ deliveryId, text }))).toEqual([
      { deliveryId: "first", text: "updated result" },
      { deliveryId: "second", text: "暂无微信新消息" },
    ]);
  });

  it("reads persisted changes between instances so acknowledgements and subsequent enqueues are not lost", () => {
    const file = storePath();
    const first = new CronNotificationOutbox(file);
    const second = new CronNotificationOutbox(file);
    first.enqueue(payload("first"));
    second.enqueue(payload("second"));
    expect(first.list().map((entry) => entry.deliveryId)).toEqual(["first", "second"]);
    expect(first.remove("first")).toBe(true);
    second.enqueue(payload("third"));

    expect(new CronNotificationOutbox(file).list().map((entry) => entry.deliveryId)).toEqual(["second", "third"]);
    expect(second.remove("first")).toBe(false);
    expect(second.remove("second")).toBe(true);
    expect(new CronNotificationOutbox(file).list().map((entry) => entry.deliveryId)).toEqual(["third"]);
  });

  it("keeps the most recent 256 queued IDs and bounds the persisted file", () => {
    const file = storePath();
    const outbox = new CronNotificationOutbox(file);
    for (let index = 0; index < CronNotificationOutbox.maxEntries + 2; index += 1) {
      outbox.enqueue(payload(`id-${index}`));
    }
    const saved = new CronNotificationOutbox(file).list();

    expect(saved).toHaveLength(256);
    expect(saved[0].deliveryId).toBe("id-2");
    expect(saved.at(-1)?.deliveryId).toBe("id-257");
    outbox.enqueue({ ...payload("id-2"), text: "retry result" });
    expect(outbox.list()).toHaveLength(256);
    expect(outbox.list()[0].text).toBe("retry result");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).entries).toHaveLength(256);
  });

  it("does not retain caller mutations or list mutations in the saved notification", () => {
    const outbox = new CronNotificationOutbox(storePath());
    const notification = payload();
    outbox.enqueue(notification);
    (notification.metadata as Record<string, unknown>).cronDeliveryId = "changed by caller";
    const listed = outbox.list();
    listed[0].text = "changed by list caller";
    (listed[0].metadata as Record<string, unknown>).cronDeliveryId = "changed in list";

    expect(outbox.list()).toEqual([payload()]);
  });

  it.each([
    "{not json",
    JSON.stringify([]),
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [{ deliveryId: "id", chat_id: "" }] }),
    JSON.stringify({ version: 1, entries: [payload("duplicate"), payload("duplicate")] }),
    JSON.stringify({ version: 1, entries: Array.from({ length: 257 }, (_, index) => payload(`id-${index}`)) }),
  ])("preserves corrupt or unsupported store data when reading or mutating it", (content) => {
    const file = storePath();
    writeFixture(file, content);
    const outbox = new CronNotificationOutbox(file);

    expect(() => outbox.list()).toThrow(/corrupt.*file preserved/);
    expect(() => outbox.enqueue(payload())).toThrow(/corrupt.*file preserved/);
    expect(() => outbox.remove("id")).toThrow(/corrupt.*file preserved/);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });

  it.each(["writeFileSync", "fsyncSync", "renameSync"] as const)("preserves the old queue and removes temporary files when %s fails", (operation) => {
    const file = storePath();
    const outbox = new CronNotificationOutbox(file);
    outbox.enqueue(payload("saved"));
    const previous = fs.readFileSync(file, "utf8");
    const failure = vi.spyOn(fs, operation).mockImplementation(() => { throw new Error("simulated storage failure"); });

    expect(() => outbox.enqueue(payload("not saved"))).toThrow("simulated storage failure");
    failure.mockRestore();
    expect(fs.readFileSync(file, "utf8")).toBe(previous);
    expect(new CronNotificationOutbox(file).list().map((entry) => entry.deliveryId)).toEqual(["saved"]);
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });

  it("uses the same atomic replacement path on Windows while avoiding directory fsync", () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    const file = storePath();
    const outbox = new CronNotificationOutbox(file);
    outbox.enqueue(payload("first"));
    const rename = vi.spyOn(fs, "renameSync");
    const sync = vi.spyOn(fs, "fsyncSync");

    outbox.enqueue(payload("second"));

    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename.mock.calls[0][1]).toBe(file);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(new CronNotificationOutbox(file).list().map((entry) => entry.deliveryId)).toEqual(["first", "second"]);
  });

  it("rejects missing identity fields and non-serializable payloads before altering the queue", () => {
    const file = storePath();
    const outbox = new CronNotificationOutbox(file);
    outbox.enqueue(payload("saved"));
    const previous = fs.readFileSync(file, "utf8");
    const circular = payload("circular");
    circular.circular = circular;

    expect(() => outbox.enqueue({ ...payload(), deliveryId: " " })).toThrow(/deliveryId and chat_id/);
    expect(() => outbox.enqueue({ ...payload(), chat_id: "" })).toThrow(/deliveryId and chat_id/);
    expect(() => outbox.enqueue(circular)).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(previous);
  });

  it("propagates a read-access failure rather than treating an unreadable queue as empty", () => {
    const file = storePath();
    const outbox = new CronNotificationOutbox(file);
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw denied; });

    expect(() => outbox.list()).toThrow(denied);
    expect(() => outbox.enqueue(payload())).toThrow(denied);
    expect(fs.existsSync(file)).toBe(false);
  });
});
