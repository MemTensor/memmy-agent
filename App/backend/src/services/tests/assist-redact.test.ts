import { describe, expect, it } from "vitest";
import { REDACTED, findSecrets, redactSecrets, redactSteps, redactTranscript } from "../assist/redact.js";

describe("redactSecrets", () => {
  it("hides a PEM private key whole", () => {
    const text = [
      "写进 ~/.ssh/id_rsa：",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
      "-----END OPENSSH PRIVATE KEY-----"
    ].join("\n");
    const result = redactSecrets(text);
    expect(result.count).toBe(1);
    expect(result.text).not.toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU");
    expect(result.text).toContain(REDACTED);
  });

  it("hides the usual token prefixes", () => {
    const text = [
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_0123456789abcdefghijABCDEFGHIJ",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "xoxb-123456789012-abcdefghijkl",
      "glpat-abcdefghij1234567890",
      "AIzaSyA1234567890abcdefghijklmnopqrstuv",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    ].join(" ");
    const result = redactSecrets(text);
    expect(result.count).toBe(7);
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.text).not.toContain("ghp_0123");
    expect(result.text).not.toContain("sk-ant-api03");
    expect(result.text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("hides authorization and cookie header values but keeps the header name", () => {
    const text = "curl -H 'Authorization: Bearer abc123def456ghi' -H 'Cookie: session=xyz789'";
    const result = redactSecrets(text);
    expect(result.text).toContain("Authorization: Bearer [已隐藏]");
    expect(result.text).toContain("Cookie: [已隐藏]");
    expect(result.text).not.toContain("abc123def456ghi");
    expect(result.text).not.toContain("xyz789");
  });

  it("hides assignment values by key name, case-insensitively", () => {
    const text = [
      "PASSWORD=hunter2",
      "GH_TOKEN=plainvalue",
      "STRIPE_API_KEY=sk_live_abcdef",
      "db_password: s3cr3t!",
      "export MY_SECRET='quoted value'"
    ].join("\n");
    const result = redactSecrets(text);
    expect(result.count).toBe(5);
    expect(result.text).not.toContain("hunter2");
    expect(result.text).not.toContain("plainvalue");
    expect(result.text).not.toContain("s3cr3t!");
    expect(result.text).not.toContain("quoted value");
    expect(result.text).toContain("PASSWORD=[已隐藏]");
  });

  it("leaves ordinary text alone", () => {
    const text = [
      "运行 sw_vers 看到 macOS 15.6",
      "sk-learn 不是密钥",
      "使用 sk- 开头的短词不算：sk-test",
      "password 这个词出现在句子里不算",
      "报告里写着 409 conflict，链接已存在"
    ].join("\n");
    const result = redactSecrets(text);
    expect(result.count).toBe(0);
    expect(result.text).toBe(text);
  });

  it("does not count the same replacement twice", () => {
    const once = redactSecrets("PASSWORD=hunter2");
    const twice = redactSecrets(once.text);
    expect(once.count).toBe(1);
    expect(twice.count).toBe(0);
    expect(twice.text).toBe(once.text);
  });
});

describe("redactTranscript", () => {
  it("hides tool inputs and outputs and keeps names and statuses", () => {
    const { items, count } = redactTranscript([
      { kind: "text", text: "先看有没有令牌：ghp_0123456789abcdefghijABCDEFGHIJ" },
      {
        kind: "tool",
        name: "运行命令 cat .env",
        input: "cat .env",
        output: "API_KEY=sk-live-0123456789abcdefghij\nOTHER=1",
        status: "done"
      }
    ] as never);

    expect(count).toBe(2);
    const tool = items[1] as { kind: string; name: string; output: string; status: string };
    expect(tool.name).toBe("运行命令 cat .env");
    expect(tool.status).toBe("done");
    expect(tool.output).toContain("API_KEY=[已隐藏]");
    expect(tool.output).toContain("OTHER=1");
    expect(JSON.stringify(items)).not.toContain("ghp_0123");
  });
});

describe("redactSteps", () => {
  it("hides secrets in summaries and keeps the rest", () => {
    const { steps, count } = redactSteps([
      { text: "运行命令 token=ghp_0123456789abcdefghijABCDEFGHIJ", output: "" },
      { text: "运行命令 sw_vers", output: "macOS 15.6" }
    ]);
    expect(count).toBe(1);
    expect(steps[0]!.text).toContain("[已隐藏]");
    expect(steps[1]).toEqual({ text: "运行命令 sw_vers", output: "macOS 15.6" });
  });
});

describe("findSecrets", () => {
  it("reports where a secret is without the value", () => {
    const hits = findSecrets("说明\nexport GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ\n");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("密码或令牌赋值");
    expect(hits[0]!.index).toBeGreaterThan(0);
  });

  it("counts each secret once even when two rules match the same text", () => {
    // `Authorization: Bearer ghp_…` 同时命中请求头规则与 GitHub 令牌规则：只报一处。
    expect(findSecrets("Authorization: Bearer ghp_0123456789abcdefghijABCDEFGHIJ")).toHaveLength(1);
  });

  it("leaves ordinary prose alone", () => {
    expect(findSecrets("跑一下 sw_vers，把版本号贴回来。token 这个词本身不算。")).toEqual([]);
    expect(findSecrets("urllib 里的 sk-learn 不是密钥")).toEqual([]);
    expect(findSecrets("")).toEqual([]);
  });

  it("finds a private key block and a PEM file reference", () => {
    const text = [
      "#!/bin/sh",
      "cat ~/.ssh/id_rsa",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
      "-----END OPENSSH PRIVATE KEY-----"
    ].join("\n");
    expect(findSecrets(text)).toHaveLength(1);
  });
});
