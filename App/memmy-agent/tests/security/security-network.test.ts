import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureSsrfWhitelist, containsInternalUrl, validateResolvedUrl, validateUrlTarget } from "../../src/security/network.js";

function fakeResolve(host: string, results: string[]) {
  return vi.spyOn(dns, "lookup").mockImplementation(async (hostname: string) => {
    if (hostname === host) return results.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) as any;
    throw new Error(`cannot resolve ${hostname}`);
  });
}

afterEach(() => {
  configureSsrfWhitelist([]);
  vi.restoreAllMocks();
});

describe("validateUrlTarget scheme and domain basics", () => {
  it("rejects non-http schemes and missing domains", async () => {
    const [unsupportedSchemeOk, err] = await validateUrlTarget("ftp://example.com/file");
    expect(unsupportedSchemeOk).toBe(false);
    expect(err.toLowerCase()).toContain("http");
    const [missingDomainOk] = await validateUrlTarget("http://");
    expect(missingDomainOk).toBe(false);
  });

  it("rejects missing domains", async () => {
    const [ok] = await validateUrlTarget("http://");
    expect(ok).toBe(false);
  });
});

describe("validateUrlTarget private and public IP handling", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.0.0.2", "loopback_alt"],
    ["10.0.0.1", "rfc1918_10"],
    ["172.16.5.1", "rfc1918_172"],
    ["192.168.1.1", "rfc1918_192"],
    ["169.254.169.254", "metadata"],
    ["0.0.0.0", "zero"],
  ])("blocks private IPv4 %s (%s)", async (ip, label) => {
    fakeResolve("evil.com", [ip]);
    const [ok, err] = await validateUrlTarget("http://evil.com/path");
    expect(ok, `Should block ${label} (${ip})`).toBe(false);
    expect(err.toLowerCase()).toMatch(/private|blocked/);
  });

  it("blocks IPv6 loopback", async () => {
    fakeResolve("evil.com", ["::1"]);
    expect((await validateUrlTarget("http://evil.com/"))[0]).toBe(false);
  });

  it.each(["fe81::1", "fe90::1", "febf::1"])("blocks IPv6 link-local address %s from fe80::/10", async (ip) => {
    const [ok, err] = await validateUrlTarget(`http://[${ip}]/`);
    expect(ok, `Should block ${ip}`).toBe(false);
    expect(err.toLowerCase()).toMatch(/private|blocked/);
  });

  it("allows public IPs and normal HTTPS hosts", async () => {
    fakeResolve("example.com", ["93.184.216.34"]);
    let [ok, err] = await validateUrlTarget("http://example.com/page");
    expect(ok, err).toBe(true);
    vi.restoreAllMocks();
    fakeResolve("github.com", ["140.82.121.3"]);
    [ok, err] = await validateUrlTarget("https://github.com/MemTensor/memmy-agent");
    expect(ok, err).toBe(true);
  });

  it("allows normal HTTPS hosts", async () => {
    fakeResolve("github.com", ["140.82.121.3"]);
    const [ok, err] = await validateUrlTarget("https://github.com/MemTensor/memmy-agent");
    expect(ok, err).toBe(true);
  });
});

describe("containsInternalUrl shell command scanning", () => {
  it("detects internal URLs in commands", async () => {
    expect(await containsInternalUrl("curl -s http://169.254.169.254/computeMetadata/v1/")).toBe(true);
    fakeResolve("localhost", ["127.0.0.1"]);
    expect(await containsInternalUrl("wget http://localhost:8080/secret")).toBe(true);
  });

  it("allows normal commands and commands without URLs", async () => {
    fakeResolve("example.com", ["93.184.216.34"]);
    expect(await containsInternalUrl("curl https://example.com/api/data")).toBe(false);
    expect(await containsInternalUrl("echo hello && ls -la")).toBe(false);
  });

  it("detects curl to metadata service URLs", async () => {
    expect(await containsInternalUrl("curl -s http://169.254.169.254/computeMetadata/v1/")).toBe(true);
  });

  it("detects wget to localhost URLs", async () => {
    fakeResolve("localhost", ["127.0.0.1"]);
    expect(await containsInternalUrl("wget http://localhost:8080/secret")).toBe(true);
  });

  it("allows normal curl commands", async () => {
    fakeResolve("example.com", ["93.184.216.34"]);
    expect(await containsInternalUrl("curl https://example.com/api/data")).toBe(false);
  });

  it("returns false when commands contain no URLs", async () => {
    expect(await containsInternalUrl("echo hello && ls -la")).toBe(false);
  });

  it("detects internal URLs with mixed-case schemes", async () => {
    expect(await containsInternalUrl("curl HTTP://127.0.0.1/admin")).toBe(true);
    expect(await containsInternalUrl("curl HtTp://169.254.169.254/latest")).toBe(true);
  });

  it("stops URL matching at shell separators", async () => {
    expect(await containsInternalUrl("curl http://127.0.0.1; echo ok")).toBe(true);
    fakeResolve("example.com", ["93.184.216.34"]);
    expect(await containsInternalUrl("curl https://example.com|cat")).toBe(false);
  });

  it("detects hostnames that resolve to internal addresses", async () => {
    fakeResolve("metadata.local", ["169.254.169.254"]);
    expect(await containsInternalUrl("curl http://metadata.local/latest")).toBe(true);
  });
});

describe("validateResolvedUrl post-fetch target checks", () => {
  it("allows malformed and unresolvable final URLs like nanobot", async () => {
    expect(await validateResolvedUrl("not a url")).toEqual([true, ""]);
    vi.spyOn(dns, "lookup").mockRejectedValue(new Error("cannot resolve"));
    expect(await validateResolvedUrl("http://definitely-unresolvable.invalid/")).toEqual([true, ""]);
  });

  it("allows public resolved hosts", async () => {
    fakeResolve("example.com", ["93.184.216.34"]);
    expect(await validateResolvedUrl("https://example.com/file.txt")).toEqual([true, ""]);
  });

  it("blocks private literal and resolved final URLs", async () => {
    expect((await validateResolvedUrl("http://127.0.0.1/metadata"))[0]).toBe(false);
    fakeResolve("metadata.local", ["169.254.169.254"]);
    expect((await validateResolvedUrl("http://metadata.local/latest"))[0]).toBe(false);
  });
});

describe("SSRF whitelist", () => {
  it("blocks CGNAT by default and allows it when whitelisted", async () => {
    fakeResolve("ts.local", ["100.100.1.1"]);
    expect((await validateUrlTarget("http://ts.local/api"))[0]).toBe(false);
    configureSsrfWhitelist(["100.64.0.0/10"]);
    expect((await validateUrlTarget("http://ts.local/api"))[0]).toBe(true);
  });

  it("does not unblock other private ranges and ignores invalid CIDR entries", async () => {
    configureSsrfWhitelist(["not-a-cidr", "100.64.0.0/10"]);
    fakeResolve("evil.com", ["10.0.0.1"]);
    expect((await validateUrlTarget("http://evil.com/secret"))[0]).toBe(false);
    vi.restoreAllMocks();
    fakeResolve("ts.local", ["100.100.1.1"]);
    expect((await validateUrlTarget("http://ts.local/api"))[0]).toBe(true);
  });
});
