import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const privacy = vi.hoisted(() => ({ available: true, private: true }));
vi.mock("../../../../src/tools/computer-history/win/private-files.js", () => ({
  prepareWindowsWeChatState: vi.fn(() => {
    if (!privacy.available) throw new Error("Windows WeChat local reader is unavailable");
  }),
  validateWindowsWeChatConsent: vi.fn(() => privacy.private),
}));
import { prepareWindowsWeChatState, validateWindowsWeChatConsent } from "../../../../src/tools/computer-history/win/private-files.js";
import { WeChatHistoryConsentStore } from "../../../../src/tools/computer-history/mac/wechat-consent.js";

const directories: string[] = [];
beforeEach(() => { privacy.available = true; privacy.private = true; vi.clearAllMocks(); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function store(): WeChatHistoryConsentStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-wechat-consent-"));
  directories.push(directory);
  return new WeChatHistoryConsentStore(path.join(directory, "wechat", "consent.json"));
}

describe("WeChat History consent", () => {
  it("fails closed until the user grants consent, then revokes immediately", () => {
    const consent = store();
    expect(consent.read().enabled).toBe(false);
    expect(consent.grant().enabled).toBe(true);
    expect(consent.read().consentedAt).toBeTruthy();
    if (process.platform !== "win32") expect(fs.statSync(consent.filePath).mode & 0o777).toBe(0o600);
    const keyFile = path.join(path.dirname(consent.filePath), "keys.json");
    fs.writeFileSync(keyFile, "test key material", { mode: 0o600 });
    expect(consent.revoke().enabled).toBe(false);
    expect(consent.read().enabled).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  });

  it("treats a corrupt or incomplete file as disabled", () => {
    const consent = store();
    fs.mkdirSync(path.dirname(consent.filePath));
    fs.writeFileSync(consent.filePath, '{"version":1,"enabled":true}');
    expect(consent.read().enabled).toBe(false);
    fs.writeFileSync(consent.filePath, "not json");
    expect(consent.read().enabled).toBe(false);
    fs.writeFileSync(consent.filePath,
      '{"version":1,"enabled":false,"consentId":"stale","consentedAt":"yesterday"}');
    expect(consent.read().consentId).toBeNull();
    consent.grant();
    fs.chmodSync(consent.filePath, 0o644);
    if (process.platform !== "win32") expect(consent.read().enabled).toBe(false);
  });

  it("uses Windows ownership and ACL checks for a legacy same-user consent file", () => {
    const consent = store();
    consent.grant();
    fs.chmodSync(consent.filePath, 0o644);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(consent.read().enabled).toBe(true);
    expect(validateWindowsWeChatConsent).toHaveBeenCalledWith(consent.filePath);
    privacy.private = false;
    expect(consent.read().enabled).toBe(false);
  });

  it("protects Windows state before granting and never enables if the reader is absent", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const consent = store();
    privacy.available = false;
    expect(() => consent.grant()).toThrow("Windows WeChat local reader is unavailable");
    expect(consent.read().enabled).toBe(false);
    expect(fs.existsSync(consent.filePath)).toBe(false);
    privacy.available = true;
    expect(consent.grant().enabled).toBe(true);
    expect(prepareWindowsWeChatState).toHaveBeenCalledWith(path.dirname(consent.filePath));
  });

  it("revokes Windows consent and removes keys immediately without the Python runtime", () => {
    const consent = store();
    consent.grant();
    const keyFile = path.join(path.dirname(consent.filePath), "keys.json");
    fs.writeFileSync(keyFile, "private fixture");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    privacy.available = false;
    privacy.private = false;
    expect(consent.revoke().enabled).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(prepareWindowsWeChatState).not.toHaveBeenCalled();
  });
});
