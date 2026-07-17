/** Cloud service tests. */
import { describe, expect, it } from "vitest";
import { CLOUD_SERVICE_ENV_KEY, resolveCloudServiceBaseUrl } from "@memmy/local-api-contracts";

describe("resolveCloudServiceBaseUrl", () => {
  it("变量名固定为 MEMMY_CLOUD_SERVICE", () => {
    expect(CLOUD_SERVICE_ENV_KEY).toBe("MEMMY_CLOUD_SERVICE");
  });

  it("返回去除首尾空白后的网关 base", () => {
    expect(resolveCloudServiceBaseUrl("  https://gw.example.cn  ")).toBe("https://gw.example.cn");
  });

  it("缺失或空白抛错,不内置任何 URL 默认值", () => {
    expect(() => resolveCloudServiceBaseUrl(undefined)).toThrow(/MEMMY_CLOUD_SERVICE/);
    expect(() => resolveCloudServiceBaseUrl("   ")).toThrow(/MEMMY_CLOUD_SERVICE/);
  });
});
