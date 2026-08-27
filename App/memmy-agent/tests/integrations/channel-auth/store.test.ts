import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pairing from "../../../src/integrations/channel-auth/index.js";
import {
  PAIRING_CODE_ALPHABET,
  approveCode,
  clearStore,
  denyCode,
  generateCode,
  getApproved,
  handlePairingCommand,
  isApproved,
  listPending,
  revoke,
  setPairingLoggerForTests,
  setStorePathForTests,
} from "../../../src/integrations/channel-auth/store.js";

let root: string;
type LogEntry = [level: "info" | "warn", message: string, meta?: Record<string, unknown>];

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureLogs(): LogEntry[] {
  const logs: LogEntry[] = [];
  setPairingLoggerForTests({
    info: (message, meta) => logs.push(["info", message, meta]),
    warn: (message, meta) => logs.push(["warn", message, meta]),
  });
  return logs;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-pairing-"));
  setStorePathForTests(path.join(root, "pairing.json"));
  setPairingLoggerForTests(noopLogger);
  clearStore();
});

afterEach(() => {
  setPairingLoggerForTests(null);
  setStorePathForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("pairing exports", () => {
  it("exports every public pairing API name", () => {
    for (const name of [
      "approveCode",
      "denyCode",
      "formatExpiry",
      "formatPairingReply",
      "generateCode",
      "getApproved",
      "handlePairingCommand",
      "isApproved",
      "listPending",
      "revoke",
      "PAIRING_CODE_META_KEY",
      "PAIRING_COMMAND_META_KEY",
    ]) {
      expect(pairing).toHaveProperty(name);
    }
  });
});

describe("pairing code generation", () => {
  it("generates 4-4 uppercase alphanumeric codes", () => {
    const code = generateCode("telegram", "123");

    expect(code).toHaveLength(9);
    expect(code[4]).toBe("-");
    expect(code.replace("-", "")).toMatch(/^[A-Z0-9]+$/);
  });

  it("uses the nanobot-compatible uppercase alphanumeric alphabet", () => {
    expect(PAIRING_CODE_ALPHABET).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    for (const char of ["I", "O", "0", "1"]) expect(PAIRING_CODE_ALPHABET).toContain(char);
  });

  it("generates unique codes", () => {
    const codes = new Set(
      [...Array(20).keys()].map((index) => generateCode("telegram", String(index))),
    );

    expect(codes.size).toBe(20);
  });

  it("expires pending codes by TTL", async () => {
    const valid = generateCode("telegram", "123", 1);
    expect(approveCode(valid)).toEqual(["telegram", "123"]);

    const expired = generateCode("telegram", "456", 0);
    await sleep(5);

    expect(approveCode(expired)).toBeNull();
  });
});

describe("pairing approval and denial", () => {
  it("moves approved codes into the approved list", () => {
    const code = generateCode("telegram", "123");

    expect(isApproved("telegram", "123")).toBe(false);
    expect(approveCode(code)).toEqual(["telegram", "123"]);
    expect(isApproved("telegram", "123")).toBe(true);
    expect(getApproved("telegram")).toEqual(["123"]);
  });

  it("denies pending codes", () => {
    const code = generateCode("telegram", "123");

    expect(denyCode(code)).toBe(true);
    expect(approveCode(code)).toBeNull();
  });

  it("returns false for unknown deny codes", () => {
    expect(denyCode("UNKNOWN")).toBe(false);
  });

  it("returns null when approving an expired code", async () => {
    const code = generateCode("telegram", "123", 0);
    await sleep(5);

    expect(approveCode(code)).toBeNull();
  });
});

describe("pairing revoke", () => {
  it("removes approved senders", () => {
    const code = generateCode("telegram", "123");
    approveCode(code);

    expect(isApproved("telegram", "123")).toBe(true);
    expect(revoke("telegram", "123")).toBe(true);
    expect(isApproved("telegram", "123")).toBe(false);
    expect(getApproved("telegram")).toEqual([]);
  });

  it("returns false for unknown revoked senders", () => {
    expect(revoke("telegram", "999")).toBe(false);
  });
});

describe("pairing pending list", () => {
  it("returns an empty list when there are no pending requests", () => {
    expect(listPending()).toEqual([]);
  });

  it("lists pending requests", () => {
    generateCode("telegram", "123");
    generateCode("discord", "456");

    const pending = listPending();

    expect(pending).toHaveLength(2);
    expect(new Set(pending.map((item) => item.channel))).toEqual(new Set(["telegram", "discord"]));
    expect(pending.every((item) => item.senderId && item.createdAt && item.expiresAt)).toBe(true);
  });

  it("does not list expired pending requests", async () => {
    generateCode("telegram", "123", 0);
    await sleep(5);

    expect(listPending()).toEqual([]);
  });
});

describe("pairing command handler", () => {
  it("lists an empty store", () => {
    expect(handlePairingCommand("telegram", "list")).toBe("No pending pairing requests.");
  });

  it("lists pending requests", () => {
    const code = generateCode("telegram", "123");

    const reply = handlePairingCommand("telegram", "list");

    expect(reply).toContain("Pending pairing requests:");
    expect(reply).toMatch(new RegExp(`- \`${code}\` \\| telegram \\| 123 \\| \\d+s`));
  });

  it("approves pairing codes", () => {
    const code = generateCode("telegram", "123");
    const reply = handlePairingCommand("telegram", `approve ${code}`);

    expect(reply).toContain("Approved");
    expect(reply).toContain("123");
    expect(isApproved("telegram", "123")).toBe(true);
  });

  it("reports invalid approve codes", () => {
    expect(handlePairingCommand("telegram", "approve BAD-CODE")).toBe(
      "Invalid or expired pairing code: `BAD-CODE`",
    );
  });

  it("shows approve usage when no code is provided", () => {
    expect(handlePairingCommand("telegram", "approve")).toBe("Usage: `/pairing approve <code>`");
  });

  it("denies pairing codes", () => {
    const code = generateCode("telegram", "123");

    expect(handlePairingCommand("telegram", `deny ${code}`)).toContain("Denied");
    expect(approveCode(code)).toBeNull();
  });

  it("reports unknown deny codes", () => {
    expect(handlePairingCommand("telegram", "deny BAD-CODE")).toBe(
      "Pairing code `BAD-CODE` not found or already expired",
    );
  });

  it("revokes senders from the current channel", () => {
    const code = generateCode("telegram", "123");
    approveCode(code);

    const reply = handlePairingCommand("telegram", "revoke 123");

    expect(reply).toContain("Revoked");
    expect(isApproved("telegram", "123")).toBe(false);
  });

  it("revokes senders from another channel", () => {
    const code = generateCode("discord", "456");
    approveCode(code);

    const reply = handlePairingCommand("telegram", "revoke discord 456");

    expect(reply).toContain("Revoked");
    expect(isApproved("discord", "456")).toBe(false);
  });

  it("reports unknown revoked senders", () => {
    expect(handlePairingCommand("telegram", "revoke 999")).toContain(
      "was not in the approved list",
    );
  });

  it("shows revoke usage when no sender is provided", () => {
    expect(handlePairingCommand("telegram", "revoke")).toBe(
      "Usage: `/pairing revoke <user_id>` or `/pairing revoke <channel> <user_id>`",
    );
  });

  it("does not revoke when revoke receives too many arguments", () => {
    const code = generateCode("discord", "456");
    approveCode(code);

    const reply = handlePairingCommand("telegram", "revoke discord 456 extra");

    expect(reply).toBe(
      "Usage: `/pairing revoke <user_id>` or `/pairing revoke <channel> <user_id>`",
    );
    expect(isApproved("discord", "456")).toBe(true);
  });

  it("reports unknown subcommands", () => {
    expect(handlePairingCommand("telegram", "foo")).toBe(
      [
        "Unknown pairing command.",
        "Usage: `/pairing [list|approve <code>|deny <code>|revoke <user_id>|revoke <channel> <user_id>]`",
      ].join("\n"),
    );
  });

  it("defaults empty command text to list", () => {
    generateCode("telegram", "123");

    expect(handlePairingCommand("telegram", "")).toContain("Pending pairing requests:");
  });
});

describe("pairing store durability", () => {
  it("persists pending requests with TS field names", () => {
    const code = generateCode("telegram", "123");
    const raw = JSON.parse(fs.readFileSync(path.join(root, "pairing.json"), "utf8"));

    expect(raw.pending[code]).toMatchObject({
      channel: "telegram",
      senderId: "123",
    });
    expect(raw.pending[code].createdAt).toBeGreaterThan(0);
    expect(raw.pending[code].expiresAt).toBeGreaterThan(0);
    expect(Object.keys(raw.pending[code]).sort()).toEqual([
      "channel",
      "createdAt",
      "expiresAt",
      "senderId",
    ]);
  });

  it("loads old TS pending data without createdAt", () => {
    fs.writeFileSync(
      path.join(root, "pairing.json"),
      JSON.stringify({
        approved: {},
        pending: {
          "ABCD-EFGH": {
            channel: "telegram",
            senderId: "123",
            expiresAt: Date.now() / 1000 + 600,
          },
        },
      }),
      "utf8",
    );

    expect(listPending()).toEqual([
      {
        code: "ABCD-EFGH",
        channel: "telegram",
        senderId: "123",
        createdAt: 0,
        expiresAt: expect.any(Number),
      },
    ]);
  });

  it("recovers gracefully from corrupt JSON", () => {
    fs.writeFileSync(path.join(root, "pairing.json"), "not json{", "utf8");

    expect(listPending()).toEqual([]);
    expect(isApproved("telegram", "123")).toBe(false);
  });
});

describe("pairing store logging", () => {
  it("logs successful generate, approve, deny, and revoke events", () => {
    const logs = captureLogs();

    const approvedCode = generateCode("telegram", "123");
    approveCode(approvedCode);
    const deniedCode = generateCode("discord", "456");
    denyCode(deniedCode);
    const revokedCode = generateCode("signal", "+15551234567");
    approveCode(revokedCode);
    revoke("signal", "+15551234567");

    expect(logs).toContainEqual([
      "info",
      "Generated pairing code",
      expect.objectContaining({ code: approvedCode, senderId: "123", channel: "telegram" }),
    ]);
    expect(logs).toContainEqual([
      "info",
      "Approved pairing code",
      expect.objectContaining({ code: approvedCode, senderId: "123", channel: "telegram" }),
    ]);
    expect(logs).toContainEqual([
      "info",
      "Denied pairing code",
      expect.objectContaining({ code: deniedCode }),
    ]);
    expect(logs).toContainEqual([
      "info",
      "Revoked pairing sender",
      expect.objectContaining({ senderId: "+15551234567", channel: "signal" }),
    ]);
  });

  it("does not log successful deny or revoke events when nothing changed", () => {
    const logs = captureLogs();

    denyCode("UNKNOWN");
    revoke("telegram", "missing");

    expect(logs).toEqual([]);
  });

  it("logs a warning when the store is corrupt", () => {
    const logs = captureLogs();
    fs.writeFileSync(path.join(root, "pairing.json"), "not json{", "utf8");

    expect(listPending()).toEqual([]);
    expect(isApproved("telegram", "123")).toBe(false);
    expect(logs).toContainEqual([
      "warn",
      "Corrupted pairing store, resetting",
      expect.objectContaining({ path: path.join(root, "pairing.json") }),
    ]);
  });
});
