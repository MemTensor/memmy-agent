import { afterEach, describe, expect, it, vi } from "vitest";
import { InboundMessage } from "../../src/core/runtime-messages/events.js";
import { registerBuiltinCommands } from "../../src/command/builtin.js";
import { CommandContext, CommandRouter } from "../../src/command/router.js";
import { generateCode, setStorePathForTests, clearStore } from "../../src/integrations/channel-auth/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];

function router(): CommandRouter {
  const r = new CommandRouter();
  registerBuiltinCommands(r);
  return r;
}

function fakeMsg(content: string): InboundMessage {
  return new InboundMessage({ channel: "telegram", chatId: "chat1", senderId: "user", content, metadata: {} });
}

function setupPairingStore(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-router-pairing-"));
  roots.push(root);
  setStorePathForTests(path.join(root, "pairing.json"));
  clearStore();
  return root;
}

afterEach(() => {
  setStorePathForTests(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CommandRouter.isDispatchableCommand", () => {
  it("matches exact commands", () => {
    const r = router();
    for (const command of ["/new", "/help", "/model", "/dream", "/dream-log", "/dream-restore", "/goal", "/pairing"]) {
      expect(r.isDispatchableCommand(command)).toBe(true);
    }
  });

  it("matches prefix commands with arguments", () => {
    const r = router();
    for (const command of ["/dream-log abc123", "/dream-restore def456", "/model fast", "/goal migrate the database", "/pairing list"]) {
      expect(r.isDispatchableCommand(command)).toBe(true);
    }
  });

  it("does not match priority commands", () => {
    const r = router();
    expect(r.isDispatchableCommand("/stop")).toBe(false);
    expect(r.isDispatchableCommand("/restart")).toBe(false);
  });

  it("does not match regular text", () => {
    const r = router();
    expect(r.isDispatchableCommand("hello")).toBe(false);
    expect(r.isDispatchableCommand("what is 2+2?")).toBe(false);
    expect(r.isDispatchableCommand("")).toBe(false);
  });

  it("is case-insensitive", () => {
    const r = router();
    expect(r.isDispatchableCommand("/NEW")).toBe(true);
    expect(r.isDispatchableCommand("/Help")).toBe(true);
    expect(r.isDispatchableCommand("/PAIRING")).toBe(true);
  });

  it("strips surrounding whitespace", () => {
    const r = router();
    expect(r.isDispatchableCommand("  /new  ")).toBe(true);
    expect(r.isDispatchableCommand("  /pairing list  ")).toBe(true);
  });

  it("does not match unknown slash commands", () => {
    const r = router();
    expect(r.isDispatchableCommand("/unknown")).toBe(false);
    expect(r.isDispatchableCommand("/foo bar")).toBe(false);
  });
});

describe("mid-turn command dispatch", () => {
  it("dispatches /new with session null", async () => {
    const r = router();
    const session = { messages: [], lastConsolidated: 0, clear: vi.fn(), key: "telegram:chat1" };
    const loop = {
      sessions: { getOrCreate: vi.fn(() => session), save: vi.fn(), invalidate: vi.fn() },
      scheduleBackground: vi.fn(),
      cancelActiveTasks: vi.fn(async () => 0),
    };
    const msg = fakeMsg("/new");
    const out = await r.dispatch(new CommandContext({ msg, session: null, key: "telegram:chat1", raw: "/new", loop }));
    expect(out?.content).toContain("New session");
    expect(loop.sessions.getOrCreate).toHaveBeenCalledWith("telegram:chat1");
  });

  it("dispatches /help with session null", async () => {
    const r = router();
    const msg = fakeMsg("/help");
    const out = await r.dispatch(new CommandContext({ msg, session: null, key: "telegram:chat1", raw: "/help", loop: {} }));
    expect(out).not.toBeNull();
  });

  it("populates args for prefix commands", async () => {
    const custom = new CommandRouter();
    const captured: string[] = [];
    custom.prefix("/test ", async (ctx) => {
      captured.push(ctx.args);
      return null;
    });
    await custom.dispatch(new CommandContext({ msg: fakeMsg("/test hello world"), key: "telegram:chat1", raw: "/test hello world", loop: {} }));
    expect(captured).toEqual(["hello world"]);
  });

  it("returns null for non-commands", async () => {
    const r = router();
    const out = await r.dispatch(new CommandContext({ msg: fakeMsg("hello world"), key: "telegram:chat1", raw: "hello world", loop: {} }));
    expect(out).toBeNull();
  });
});

describe("pairing command dispatch", () => {
  it("dispatches pairing list", async () => {
    setupPairingStore();
    const r = router();
    const code = generateCode("telegram", "123");
    const msg = fakeMsg("/pairing list");

    const out = await r.dispatch(new CommandContext({ msg, session: null, key: "telegram:chat1", raw: "/pairing list", args: "list", loop: {} }));

    expect(out?.content).toContain(code);
    expect(out?.metadata.pairingCommand).toBe(true);
  });

  it("dispatches pairing approve", async () => {
    setupPairingStore();
    const r = router();
    const code = generateCode("telegram", "123");
    const msg = fakeMsg(`/pairing approve ${code}`);

    const out = await r.dispatch(new CommandContext({ msg, session: null, key: "telegram:chat1", raw: `/pairing approve ${code}`, args: `approve ${code}`, loop: {} }));

    expect(out?.content).toContain("Approved");
  });

  it("dispatches pairing revoke", async () => {
    setupPairingStore();
    const r = router();
    const code = generateCode("telegram", "123");
    await r.dispatch(new CommandContext({ msg: fakeMsg(`/pairing approve ${code}`), session: null, key: "telegram:chat1", raw: `/pairing approve ${code}`, args: `approve ${code}`, loop: {} }));
    const msg = fakeMsg("/pairing revoke 123");

    const out = await r.dispatch(new CommandContext({ msg, session: null, key: "telegram:chat1", raw: "/pairing revoke 123", args: "revoke 123", loop: {} }));

    expect(out?.content).toContain("Revoked");
  });
});
