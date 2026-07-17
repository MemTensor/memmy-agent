import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../../config/paths.js";

export const PAIRING_CODE_META_KEY = "pairingCode";
export const PAIRING_COMMAND_META_KEY = "pairingCommand";
export const PAIRING_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

type PendingPairing = { channel: string; senderId: string; createdAt: number; expiresAt: number };
type PairingStoreData = {
  approved: Map<string, Set<string>>;
  pending: Map<string, PendingPairing>;
};
type PairingLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

const pending = new Map<string, PendingPairing>();
const approved = new Set<string>();
let storePathOverride: string | null = null;
let logger: PairingLogger = defaultLogger();

function key(channel: string, senderId: string): string {
  return `${channel}:${senderId}`;
}

function defaultLogger(): PairingLogger {
  if (process.env.NODE_ENV === "test") return { info: () => undefined, warn: () => undefined };
  return {
    info: (message, meta) => console.info(message, meta ?? ""),
    warn: (message, meta) => console.warn(message, meta ?? ""),
  };
}

function memoryOnly(): boolean {
  return !storePathOverride && process.env.NODE_ENV === "test" && !process.env.MEMMY_AGENT_DATA_DIR;
}

export function storePath(): string {
  return storePathOverride ?? path.join(getDataDir(), "pairing.json");
}

export function setStorePathForTests(file: string | null): void {
  storePathOverride = file;
  pending.clear();
  approved.clear();
}

export function setPairingLoggerForTests(next: PairingLogger | null): void {
  logger = next ?? defaultLogger();
}

function emptyStore(): PairingStoreData {
  return { approved: new Map(), pending: new Map() };
}

function loadStore(): PairingStoreData {
  if (memoryOnly()) {
    const grouped = new Map<string, Set<string>>();
    for (const item of approved) {
      const [channel, ...rest] = item.split(":");
      const senderId = rest.join(":");
      if (!grouped.has(channel)) grouped.set(channel, new Set());
      grouped.get(channel)!.add(senderId);
    }
    return { approved: grouped, pending: new Map(pending) };
  }
  const file = storePath();
  if (!fs.existsSync(file)) return emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const approvedMap = new Map<string, Set<string>>();
    for (const [channel, users] of Object.entries(raw.approved ?? {})) {
      approvedMap.set(channel, new Set(Array.isArray(users) ? users.map(String) : []));
    }
    const pendingMap = new Map<string, PendingPairing>();
    for (const [code, info] of Object.entries(raw.pending ?? {})) {
      if (!info || typeof info !== "object") continue;
      const row = info as Record<string, any>;
      pendingMap.set(code, {
        channel: String(row.channel),
        senderId: String(row.senderId),
        createdAt: Number(row.createdAt ?? 0),
        expiresAt: Number(row.expiresAt ?? 0),
      });
    }
    return { approved: approvedMap, pending: pendingMap };
  } catch (error) {
    logger.warn("Corrupted pairing store, resetting", { path: file, error: String(error) });
    return emptyStore();
  }
}

function saveStore(data: PairingStoreData): void {
  approved.clear();
  pending.clear();
  for (const [channel, users] of data.approved.entries()) {
    for (const senderId of users) approved.add(key(channel, senderId));
  }
  for (const [code, row] of data.pending.entries()) pending.set(code, row);
  if (memoryOnly()) return;
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    approved: Object.fromEntries(
      [...data.approved.entries()].map(([channel, users]) => [channel, [...users].sort()]),
    ),
    pending: Object.fromEntries(
      [...data.pending.entries()].map(([code, row]) => [
        code,
        {
          channel: row.channel,
          senderId: row.senderId,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        },
      ]),
    ),
  };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function gcPending(data: { pending: Map<string, { expiresAt: number }> }): void {
  const now = Date.now() / 1000;
  for (const [code, row] of data.pending.entries())
    if (row.expiresAt <= now) data.pending.delete(code);
}

function randomCode(): string {
  const pick = () => PAIRING_CODE_ALPHABET[crypto.randomInt(0, PAIRING_CODE_ALPHABET.length)];
  return `${Array.from({ length: 4 }, pick).join("")}-${Array.from({ length: 4 }, pick).join("")}`;
}

export function clearStore(): void {
  pending.clear();
  approved.clear();
  if (!memoryOnly()) saveStore({ approved: new Map(), pending: new Map() });
}

export function generateCode(channel: string, senderId: string, ttlS = 600): string {
  const data = loadStore();
  gcPending(data);
  let code = randomCode();
  while (data.pending.has(code)) code = randomCode();
  const now = Date.now() / 1000;
  data.pending.set(code, { channel, senderId, createdAt: now, expiresAt: now + ttlS });
  saveStore(data);
  logger.info("Generated pairing code", { code, senderId, channel });
  return code;
}

export function approveCode(code: string): [string, string] | null {
  const data = loadStore();
  gcPending(data);
  const row = data.pending.get(code);
  if (!row) return null;
  data.pending.delete(code);
  if (!data.approved.has(row.channel)) data.approved.set(row.channel, new Set());
  data.approved.get(row.channel)!.add(row.senderId);
  saveStore(data);
  logger.info("Approved pairing code", { code, senderId: row.senderId, channel: row.channel });
  return [row.channel, row.senderId];
}

export function denyCode(code: string): boolean {
  const data = loadStore();
  gcPending(data);
  const removed = data.pending.delete(code);
  if (removed) {
    saveStore(data);
    logger.info("Denied pairing code", { code });
  }
  return removed;
}
export function isApproved(channel: string, senderId: string): boolean {
  const data = loadStore();
  return data.approved.get(channel)?.has(senderId) ?? false;
}
export function listPending(): any[] {
  const data = loadStore();
  gcPending(data);
  saveStore(data);
  return [...data.pending.entries()].map(([code, value]) => ({
    code,
    channel: value.channel,
    senderId: value.senderId,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  }));
}
export function revoke(channel: string, senderId: string): boolean {
  const data = loadStore();
  const users = data.approved.get(channel);
  if (!users?.delete(senderId)) return false;
  if (!users.size) data.approved.delete(channel);
  saveStore(data);
  logger.info("Revoked pairing sender", { senderId, channel });
  return true;
}
export function getApproved(channel: string): string[] {
  const data = loadStore();
  return [...(data.approved.get(channel) ?? [])].sort();
}
export function formatPairingReply(code: string): string {
  return [
    "Hi there! This assistant only responds to approved users.",
    "",
    `Your pairing code is: \`${code}\``,
    "",
    "To get access, ask the owner to approve this code:",
    `- In this chat: send \`/pairing approve ${code}\``,
  ].join("\n");
}
export function formatExpiry(expiresAt: number): string {
  const remaining = Math.floor(expiresAt - Date.now() / 1000);
  return remaining > 0 ? `${remaining}s` : "expired";
}
export function handlePairingCommand(channel: string, subcommandText: string): string {
  const parts = subcommandText.trim().split(/\s+/).filter(Boolean);
  const cmd = parts[0] ?? "list";
  if (cmd === "list") {
    const rows = listPending();
    if (!rows.length) return "No pending pairing requests.";
    return `Pending pairing requests:\n${rows
      .map((r) => `- \`${r.code}\` | ${r.channel} | ${r.senderId} | ${formatExpiry(r.expiresAt)}`)
      .join("\n")}`;
  }
  if (cmd === "approve") {
    if (!parts[1]) return "Usage: `/pairing approve <code>`";
    const result = approveCode(parts[1]);
    return result
      ? `Approved pairing code \`${parts[1]}\` - ${result[1]} can now access ${result[0]}`
      : `Invalid or expired pairing code: \`${parts[1]}\``;
  }
  if (cmd === "deny") {
    if (!parts[1]) return "Usage: `/pairing deny <code>`";
    return denyCode(parts[1])
      ? `Denied pairing code \`${parts[1]}\``
      : `Pairing code \`${parts[1]}\` not found or already expired`;
  }
  if (cmd === "revoke") {
    if (parts.length === 2) {
      const senderId = parts[1];
      return revoke(channel, senderId)
        ? `Revoked ${senderId} from ${channel}`
        : `${senderId} was not in the approved list for ${channel}`;
    }
    if (parts.length === 3) {
      const targetChannel = parts[1];
      const senderId = parts[2];
      return revoke(targetChannel, senderId)
        ? `Revoked ${senderId} from ${targetChannel}`
        : `${senderId} was not in the approved list for ${targetChannel}`;
    }
    return "Usage: `/pairing revoke <user_id>` or `/pairing revoke <channel> <user_id>`";
  }
  return [
    "Unknown pairing command.",
    "Usage: `/pairing [list|approve <code>|deny <code>|revoke <user_id>|revoke <channel> <user_id>]`",
  ].join("\n");
}
