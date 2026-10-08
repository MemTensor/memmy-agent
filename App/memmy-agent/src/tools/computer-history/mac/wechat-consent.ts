import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface WeChatHistoryConsent {
  version: 1;
  enabled: boolean;
  consentId: string | null;
  consentedAt: string | null;
  updatedAt: string | null;
}

const DISABLED: WeChatHistoryConsent = {
  version: 1, enabled: false, consentId: null, consentedAt: null, updatedAt: null,
};

export function defaultWeChatConsentFile(): string {
  const home = process.env.MEMMY_HOME?.trim() || path.join(os.homedir(), ".memmy");
  return path.join(home, "computer-history", "wechat", "consent.json");
}

/** The one opt-in checked by both the native UI recorder and the DB reader. */
export class WeChatHistoryConsentStore {
  constructor(readonly filePath = defaultWeChatConsentFile()) {}

  read(): WeChatHistoryConsent {
    try {
      const stat = fs.lstatSync(this.filePath);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) return { ...DISABLED };
      const value: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!value || typeof value !== "object") return { ...DISABLED };
      const input = value as Record<string, unknown>;
      if (input.version !== 1 || typeof input.enabled !== "boolean") return { ...DISABLED };
      const consentId = typeof input.consentId === "string" ? input.consentId : null;
      const consentedAt = typeof input.consentedAt === "string" ? input.consentedAt : null;
      const updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : null;
      if (!input.enabled) return { ...DISABLED, updatedAt };
      if (input.enabled && (!consentedAt || !consentId)) return { ...DISABLED };
      return { version: 1, enabled: input.enabled, consentId, consentedAt, updatedAt };
    } catch {
      return { ...DISABLED };
    }
  }

  grant(): WeChatHistoryConsent {
    const previous = this.read();
    const now = new Date().toISOString();
    return this.write({ version: 1, enabled: true,
      consentId: previous.enabled ? previous.consentId : crypto.randomUUID(),
      consentedAt: previous.enabled ? previous.consentedAt : now, updatedAt: now });
  }

  revoke(): WeChatHistoryConsent {
    const revoked = this.write({ version: 1, enabled: false, consentId: null, consentedAt: null,
      updatedAt: new Date().toISOString() });
    const directory = path.dirname(this.filePath);
    for (const name of ["keys.json", "keys.next.json", "account.json"]) {
      fs.rmSync(path.join(directory, name), { force: true });
    }
    return revoked;
  }

  private write(value: WeChatHistoryConsent): WeChatHistoryConsent {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("WeChat consent directory is not a directory");
    fs.chmodSync(directory, 0o700);
    const temporary = path.join(directory, `.consent-${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temporary, this.filePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return value;
  }
}
