/** Connect channel modal state tests. */
import { describe, expect, it } from "vitest";
import {
  deriveChannelConnectResponseAfterConnectionRefresh,
  deriveChannelPhaseAfterConnectionRefresh,
  deriveInitialChannelPhase
} from "../connect-channel-modal-state.js";

describe("connect-channel-modal-state", () => {
  it("连接列表刷新为等待态时保留已有 WeChat 二维码响应", () => {
    const response = {
      status: "pendingQr" as const,
      connectionId: "channel-wechat-local",
      qrCodeDataUrl: "data:image/png;base64,abc",
      pollToken: "poll-1"
    };

    expect(
      deriveChannelConnectResponseAfterConnectionRefresh(response, {
        id: "channel-wechat-local",
        toolkit: "wechat",
        status: "pending"
      })
    ).toBe(response);
    expect(
      deriveChannelPhaseAfterConnectionRefresh({
        id: "channel-wechat-local",
        toolkit: "wechat",
        status: "pending"
      })
    ).toBeNull();
  });

  it("仅有连接列表等待态时不进入二维码相位，避免没有二维码 payload 的空等待页", () => {
    expect(
      deriveInitialChannelPhase({
        id: "channel-wechat-local",
        toolkit: "wechat",
        status: "pending"
      })
    ).toBe("idle");

    expect(
      deriveChannelPhaseAfterConnectionRefresh({
        id: "channel-wechat-local",
        toolkit: "wechat",
        status: "pending"
      })
    ).toBeNull();
  });

  it("连接列表短暂缺失连接记录时不清理已有二维码响应", () => {
    const response = {
      status: "pendingQr" as const,
      connectionId: "channel-wechat-local",
      qrCodeDataUrl: "data:image/png;base64,abc",
      pollToken: "poll-1"
    };

    expect(deriveChannelConnectResponseAfterConnectionRefresh(response, undefined)).toBe(response);
    expect(deriveChannelPhaseAfterConnectionRefresh(undefined)).toBeNull();
  });

  it("连接列表刷新为终态时清理二维码响应", () => {
    const response = {
      status: "pendingQr" as const,
      connectionId: "channel-wechat-local",
      qrCodeDataUrl: "data:image/png;base64,abc",
      pollToken: "poll-1"
    };

    expect(
      deriveChannelConnectResponseAfterConnectionRefresh(response, {
        id: "channel-wechat-local",
        toolkit: "wechat",
        status: "connected"
      })
    ).toBeUndefined();
    expect(
      deriveChannelPhaseAfterConnectionRefresh({
        id: "channel-wechat-local",
        toolkit: "wechat",
        status: "connected"
      })
    ).toBe("connected");
  });
});
