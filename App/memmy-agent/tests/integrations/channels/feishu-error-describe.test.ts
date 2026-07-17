/**
 * Feishu error summary tests.
 *
 * reportEventError previously called console.error on the entire axios error,
 * flooding gateway logs with socket/TLS internals and hiding the useful
 * code/msg. describeFeishuError compresses Feishu SDK / axios errors into a
 * one-line readable summary, including key details such as permission error
 * 99991672.
 */
import { describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import {
  describeFeishuError,
  feishuPermissionHint,
  FeishuChannel,
} from "../../../src/integrations/channels/feishu.js";

describe("describeFeishuError", () => {
  it("extracts code and msg from a lark SDK error", () => {
    const err = { code: 99991672, msg: "Access denied. scope required: im:message:send" };
    expect(describeFeishuError(err)).toBe(
      "code=99991672 msg=Access denied. scope required: im:message:send",
    );
  });

  it("extracts code and msg from an axios error carrying response.data", () => {
    const err = {
      message: "Request failed with status code 400",
      response: { status: 400, data: { code: 99991672, msg: "Access denied." } },
    };
    expect(describeFeishuError(err)).toBe("code=99991672 msg=Access denied.");
  });

  it("falls back to message when no feishu code/msg is present", () => {
    expect(describeFeishuError(new Error("socket hang up"))).toBe("socket hang up");
  });

  it("does not dump nested socket internals", () => {
    const err: any = new Error("boom");
    err.response = {
      data: { code: 1, msg: "bad" },
      request: { socket: { huge: "x".repeat(9999) } },
    };
    const out = describeFeishuError(err);
    expect(out).toBe("code=1 msg=bad");
    expect(out).not.toContain("socket");
  });
});

describe("feishuPermissionHint", () => {
  it("returns an actionable hint for the 99991672 permission error", () => {
    const err = {
      code: 99991672,
      msg: "Access denied. One of the following scopes is required: [im:message:send]",
    };
    const hint = feishuPermissionHint(err);
    expect(hint).toContain("权限不足");
    expect(hint).toContain("发布"); // Remind users that publishing a version is required.
    expect(hint).toContain("im:message:send"); // Preserve Feishu's original scope hint.
  });

  it("detects the permission error from a Chinese msg without the numeric code", () => {
    const err = { code: -1, msg: "应用尚未开通所需的应用身份权限：[im:message:send]" };
    expect(feishuPermissionHint(err)).toContain("权限不足");
  });

  it("returns null for non-permission errors", () => {
    expect(feishuPermissionHint({ code: 400, msg: "invalid card payload" })).toBeNull();
    expect(feishuPermissionHint(new Error("socket hang up"))).toBeNull();
  });
});

describe("FeishuChannel.reportEventError 捕获权限错误", () => {
  it("captures a permission error as lastError for later surfacing", () => {
    const channel = new FeishuChannel(
      { enabled: true, appId: "a", appSecret: "b", allowFrom: ["*"] },
      new MessageBus(),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(channel.lastError).toBeNull();

    channel.reportEventError({
      code: 99991672,
      msg: "Access denied. scope required: im:message:send",
    });

    expect(channel.lastError).toContain("权限不足");
    vi.restoreAllMocks();
  });

  it("does not set lastError for ordinary errors", () => {
    const channel = new FeishuChannel(
      { enabled: true, appId: "a", appSecret: "b", allowFrom: ["*"] },
      new MessageBus(),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    channel.reportEventError(new Error("socket hang up"));

    expect(channel.lastError).toBeNull();
    vi.restoreAllMocks();
  });
});
