import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTaskActivity } from "../../../src/core/agent-runtime/task-activity.js";
import { PluginUpdateLease } from "../../../src/core/agent-runtime/plugin-update-lease.js";
import { TerminalRunControl } from "../../../src/core/session/terminal-session-control.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("plugin activation task admission", () => {
  it("keeps new turns waiting until the owning lease is released", async () => {
    const activity = new AgentTaskActivity(), lease = new PluginUpdateLease(activity, null);
    expect(await lease.acquire("one")).toBe(true);
    expect(await lease.acquire("one")).toBe(true);
    expect(await lease.acquire("two")).toBe(false);
    const run = vi.fn(async () => "done");
    const turn = activity.run(run);
    await lease.release("two");
    expect(run).not.toHaveBeenCalled();
    await lease.release("one");
    expect(await turn).toBe("done");
    expect(run).toHaveBeenCalledTimes(1);
    expect(activity.busy).toBe(false);
  });

  it("cannot acquire between calls in a running turn or strand tasks after cancellation", async () => {
    const activity = new AgentTaskActivity(), lease = new PluginUpdateLease(activity, null);
    let finish!: () => void;
    const turn = activity.run(() => new Promise<void>(resolve => { finish = resolve; }));
    expect(await lease.acquire("one")).toBe(false);
    finish(); await turn;
    await lease.release("cancelled");
    expect(await lease.acquire("cancelled")).toBe(false);
    expect(await lease.acquire("next")).toBe(true);
    const run = vi.fn(async () => {}), waiting = activity.run(run);
    await lease.close(); await waiting;
    expect(run).toHaveBeenCalledOnce();
  });

  it("coordinates CLI admission across independent controllers sharing a sessions directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-update-cli-")); roots.push(root);
    const gateway = new TerminalRunControl(root), cli = new TerminalRunControl(root);
    const lease = new PluginUpdateLease(new AgentTaskActivity(), gateway);
    await cli.create("cli:existing", "first");
    expect(await lease.acquire("busy")).toBe(false);
    await cli.remove("cli:existing", "first");
    expect(await lease.acquire("idle")).toBe(true);
    const created = vi.fn();
    const starting = cli.create("cli:new", "second").then(created);
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(created).not.toHaveBeenCalled();
      expect(gateway.hasActiveRuns()).toBe(false);
    } finally { await lease.close(); await starting; }
    expect(gateway.hasActiveRuns()).toBe(true);
    expect(await lease.acquire("still-busy")).toBe(false);
    await cli.remove("cli:new", "second");
  });

  it("unblocks runtime admission if terminal coordination fails", async () => {
    const activity = new AgentTaskActivity();
    const terminal = { tryBlockStarts: async () => { throw new Error("disk failure"); } } as unknown as TerminalRunControl;
    const lease = new PluginUpdateLease(activity, terminal);
    await expect(lease.acquire("one")).rejects.toThrow("disk failure");
    expect(await activity.run(async () => "ready")).toBe("ready");
  });

  it("recovers admission when the backend owning the reservation exits", async () => {
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const activity = new AgentTaskActivity(), lease = new PluginUpdateLease(activity, null);
    try {
      expect(await lease.acquire("owner", owner.pid!)).toBe(true);
      const run = vi.fn(async () => {}), turn = activity.run(run);
      expect(run).not.toHaveBeenCalled();
      const exited = once(owner, "exit"); owner.kill(); await exited;
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: 2_500 });
      await turn;
    } finally { owner.kill(); await lease.close(); }
  });
});
