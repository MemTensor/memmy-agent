import { describe, expect, it, vi } from "vitest";
import { IMessageChannel } from "../../../src/integrations/channels/imessage.js";
import { OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { discoverChannelNames, getChannel } from "../../../src/integrations/channels/registry.js";

function makeChannel(runCommand: any) {
  return new IMessageChannel({ enabled: true, allowFrom: ["*"] }, undefined, { runCommand });
}

describe("IMessageChannel", () => {
  it("start() 记录基线 ROWID 且不回灌历史", async () => {
    const runCommand = vi.fn(async () => ({ stdout: JSON.stringify([{ maxId: 42 }]) }));
    const channel = makeChannel(runCommand);
    const spy = vi.spyOn(channel, "handleMessage");

    await channel.start();

    expect(channel.isRunning).toBe(true);
    expect((channel as any).lastRowId).toBe(42);
    expect(spy).not.toHaveBeenCalled();
    await channel.stop();
  });

  it("poll() 把新入站文本交给 handleMessage", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ maxId: 10 }]) }) // Imessage tests.
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ rowid: 11, text: "你好", handle: "+8613800000000" }]),
      });
    const channel = makeChannel(runCommand);
    const spy = vi.spyOn(channel, "handleMessage").mockResolvedValue(undefined);

    await channel.start();
    await (channel as any).poll();

    expect(spy).toHaveBeenCalledWith({
      senderId: "+8613800000000",
      chatId: "+8613800000000",
      content: "你好",
      isDm: true,
    });
    expect((channel as any).lastRowId).toBe(11);
    await channel.stop();
  });

  it("send() 用 osascript 发到目标 handle", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "" }));
    const channel = makeChannel(runCommand);

    await channel.send(
      new OutboundMessage({ channel: "imessage", chatId: "a@b.com", content: "hi" }),
    );

    const call = runCommand.mock.calls.at(-1) as unknown as [string, string[]];
    expect(call[0]).toBe("osascript");
    expect(call[1].join(" ")).toContain("a@b.com");
    expect(call[1].join(" ")).toContain("hi");
  });

  it("send() 把含引号/换行的正文作为 argv 原样传入而非拼进脚本", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "" }));
    const channel = makeChannel(runCommand);
    const content = 'line1\n"quoted"\\end';
    await channel.send(new OutboundMessage({ channel: "imessage", chatId: "a@b.com", content }));
    const call = runCommand.mock.calls.at(-1) as unknown as [string, string[]];
    expect(call[0]).toBe("osascript");
    expect(call[1]).toContain(content); // Handles expect.
    expect(call[1]).toContain("a@b.com");
  });

  it("permissionErrorHint() 命中 chat.db 无权限", () => {
    const channel = makeChannel(vi.fn());
    const hint = channel.permissionErrorHint({ stderr: "Error: unable to open database file" });
    expect(hint).toContain("完全磁盘访问");
  });

  it("poll() 读库权限不足时写入 lastError 而非抛出", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ maxId: 0 }]) })
      .mockRejectedValueOnce({ stderr: "unable to open database file" });
    const channel = makeChannel(runCommand);

    await channel.start();
    await expect((channel as any).poll()).resolves.toBeUndefined();
    expect(channel.lastError).toContain("完全磁盘访问");
    await channel.stop();
  });

  it("已注册进 BUILTIN_CHANNELS", () => {
    expect(getChannel("imessage")).toBe(IMessageChannel);
    expect(discoverChannelNames()).toContain("imessage");
  });
});
