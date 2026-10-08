import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";

afterEach(() => vi.unstubAllEnvs());

describe("personal WeChat History setup boundary", () => {
  it("does not launch connection without consent and reports a missing local reader honestly", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-wechat-service-"));
    vi.stubEnv("MEMMY_SQLCIPHER_LIBRARY", path.join(directory, "missing-sqlcipher.dylib"));
    const service = new ComputerHistoryDemoService({
      historyDirectory: path.join(directory, "histories"),
      recordingDirectory: path.join(directory, "recordings"),
      workflowDirectory: path.join(directory, "workflows"),
      weChatConsentFile: path.join(directory, "wechat", "consent.json"),
    });
    try {
      expect(service.snapshot().wechat).toMatchObject({ enabled: false, connection: "disabled" });
      expect(() => service.connectWeChat()).toThrow("disabled");
      expect(service.setWeChatChatAccess(true).wechat).toMatchObject({
        enabled: true, connection: "unavailable",
      });
      expect(() => service.connectWeChat()).toThrow("unavailable");
      expect(service.setWeChatChatAccess(false).wechat).toMatchObject({
        enabled: false, connection: "disabled",
      });
    } finally {
      await service.shutdown();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("omits WeChat History when the Mac is not Apple silicon", async () => {
    const arch = vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-wechat-service-"));
    const service = new ComputerHistoryDemoService({
      historyDirectory: path.join(directory, "histories"),
      recordingDirectory: path.join(directory, "recordings"),
      workflowDirectory: path.join(directory, "workflows"),
      weChatConsentFile: path.join(directory, "wechat", "consent.json"),
    });
    try {
      expect(service.snapshot().wechat).toBeUndefined();
      expect(() => service.setWeChatChatAccess(true)).toThrow(/Apple silicon macOS only/);
      expect(() => service.connectWeChat()).toThrow(/Apple silicon macOS only/);
      expect(service.snapshot().wechat).toBeUndefined();
    } finally {
      arch.mockRestore();
      await service.shutdown();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
