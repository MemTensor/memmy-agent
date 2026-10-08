import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WeChatHistoryConsentStore } from "../../../../src/tools/computer-history/mac/wechat-consent.js";

const directories: string[] = [];
afterEach(() => {
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
    expect(fs.statSync(consent.filePath).mode & 0o777).toBe(0o600);
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
    expect(consent.read().enabled).toBe(false);
  });
});
