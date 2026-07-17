/** Service urls tests. */
import { describe, expect, it } from "vitest";
import { resolveCloudClientConfig } from "../service-urls.js";

describe("service URL config", () => {
  it("默认网关来自 MEMMY_CLOUD_SERVICE", () => {
    expect(resolveCloudClientConfig({ MEMMY_CLOUD_SERVICE: "https://gw.example.cn" })).toEqual({
      baseUrl: "https://gw.example.cn",
      timeoutMs: 5000
    });
  });

  it("对 MEMMY_CLOUD_SERVICE 做首尾去空白", () => {
    expect(
      resolveCloudClientConfig({ MEMMY_CLOUD_SERVICE: "  https://gw.example.cn  " }).baseUrl
    ).toBe("https://gw.example.cn");
  });

  it("MEMMY_CLOUD_SERVICE 缺失时抛错,不内置 URL 默认值", () => {
    expect(() => resolveCloudClientConfig({})).toThrow(/MEMMY_CLOUD_SERVICE/);
  });

  it("lets MEMMY_CLOUD_URL override the built-in Cloud URL for local debugging", () => {
    expect(
      resolveCloudClientConfig({
        MEMMY_CLOUD_SERVICE: "https://gw.example.cn",
        MEMMY_CLOUD_URL: " http://127.0.0.1:3000 ",
        MEMMY_CLOUD_TIMEOUT_MS: "9000"
      })
    ).toEqual({
      baseUrl: "http://127.0.0.1:3000",
      timeoutMs: 9000
    });
  });

  it("MEMMY_CLOUD_URL 优先级高于 MEMMY_CLOUD_SERVICE", () => {
    expect(
      resolveCloudClientConfig({
        MEMMY_CLOUD_URL: "http://127.0.0.1:3000",
        MEMMY_CLOUD_SERVICE: "https://gw.example.cn"
      }).baseUrl
    ).toBe("http://127.0.0.1:3000");
  });
});
