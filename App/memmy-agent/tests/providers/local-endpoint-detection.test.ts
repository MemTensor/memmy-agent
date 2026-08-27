import { describe, expect, it } from "vitest";
import { OpenAICompatProvider, isLocalEndpoint } from "../../src/providers/openai-compat-provider.js";

function spec(isLocal = false): any {
  return { isLocal: isLocal, defaultApiBase: "http://localhost:11434/v1", envKey: "" };
}

describe("local endpoint detection", () => {
  it("honors spec.isLocal true", () => {
    expect(isLocalEndpoint(spec(true), null)).toBe(true);
  });

  it("returns false for non-local specs without a base URL", () => {
    expect(isLocalEndpoint(spec(false), null)).toBe(false);
  });

  it("returns false without a spec or base URL", () => {
    expect(isLocalEndpoint(null, null)).toBe(false);
  });

  it("detects localhost HTTP endpoints", () => {
    expect(isLocalEndpoint(null, "http://localhost:1234/v1")).toBe(true);
  });

  it("detects localhost HTTPS endpoints", () => {
    expect(isLocalEndpoint(null, "https://localhost:8080/v1")).toBe(true);
  });

  it("detects 127 loopback endpoints", () => {
    expect(isLocalEndpoint(null, "http://127.0.0.1:11434/v1")).toBe(true);
  });

  it("detects 192.168 private endpoints", () => {
    expect(isLocalEndpoint(null, "http://192.168.8.188:1234/v1")).toBe(true);
  });

  it("detects 10 private endpoints", () => {
    expect(isLocalEndpoint(null, "http://10.0.0.5:8000/v1")).toBe(true);
  });

  it("detects 172.16 private endpoints", () => {
    expect(isLocalEndpoint(null, "http://172.16.0.1:1234/v1")).toBe(true);
  });

  it("detects 172.31 private endpoints", () => {
    expect(isLocalEndpoint(null, "http://172.31.255.255:1234/v1")).toBe(true);
  });

  it("does not treat 172.32 as private", () => {
    expect(isLocalEndpoint(null, "http://172.32.0.1:1234/v1")).toBe(false);
  });

  it("detects Docker internal host endpoints", () => {
    expect(isLocalEndpoint(null, "http://host.docker.internal:11434/v1")).toBe(true);
  });

  it("detects IPv6 loopback endpoints", () => {
    expect(isLocalEndpoint(null, "http://[::1]:1234/v1")).toBe(true);
  });

  it("does not mark public OpenAI API as local", () => {
    expect(isLocalEndpoint(null, "https://api.openai.com/v1")).toBe(false);
  });

  it("does not mark OpenRouter as local", () => {
    expect(isLocalEndpoint(null, "https://openrouter.ai/api/v1")).toBe(false);
  });

  it("lets spec.isLocal override public-looking URLs", () => {
    expect(isLocalEndpoint(spec(true), "https://api.example.com/v1")).toBe(true);
  });

  it("matches localhost case-insensitively", () => {
    expect(isLocalEndpoint(null, "http://LOCALHOST:1234/v1")).toBe(true);
  });

  it("handles trailing slashes", () => {
    expect(isLocalEndpoint(null, "http://192.168.1.1:8080/v1/")).toBe(true);
  });

  it("does not match public hostnames containing localhost", () => {
    expect(isLocalEndpoint(null, "https://notlocalhost.example/v1")).toBe(false);
  });

  it("does not match public hostnames containing private IP prefixes", () => {
    expect(isLocalEndpoint(null, "https://api10.example.com/v1")).toBe(false);
  });

  it("handles URLs without a scheme", () => {
    expect(isLocalEndpoint(null, "192.168.1.1:8080/v1")).toBe(true);
  });
});

describe("local endpoint keepalive configuration", () => {
  it("disables keepalive for explicitly local specs", async () => {
    const localSpec = spec(true);
    localSpec.defaultApiBase = "http://localhost:11434/v1";
    const provider = new OpenAICompatProvider({ apiKey: "test", apiBase: "http://localhost:11434/v1", spec: localSpec });

    await provider.ensureClient();

    expect(provider.isLocal).toBe(true);
    expect(provider.client.fetchOptions.keepalive).toBe(false);
  });

  it("disables keepalive for LAN IP endpoints", async () => {
    const localSpec = spec(false);
    localSpec.defaultApiBase = null;
    const provider = new OpenAICompatProvider({ apiKey: "test", apiBase: "http://192.168.8.188:1234/v1", spec: localSpec });

    await provider.ensureClient();

    expect(provider.isLocal).toBe(true);
    expect(provider.client.fetchOptions.keepalive).toBe(false);
  });

  it("keeps default keepalive for cloud endpoints", async () => {
    const cloudSpec = spec(false);
    cloudSpec.defaultApiBase = "https://api.openai.com/v1";
    const provider = new OpenAICompatProvider({ apiKey: "test", apiBase: null, spec: cloudSpec });

    await provider.ensureClient();

    expect(provider.isLocal).toBe(false);
    expect(provider.client.fetchOptions).toBeUndefined();
  });
});
