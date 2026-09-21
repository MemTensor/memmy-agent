import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MacPermissionPreflight, nativePermissionDoctor, parsePermissionDoctor } from "../../../src/tools/computer-use/mac-permission-preflight.js";
import { macPermissionSettingsGuide } from "../../../src/tools/computer-use/mac-permission-settings.js";
import { MCPToolWrapper } from "../../../src/core/agent-runtime/tools/mcp.js";
import { RequestContext } from "../../../src/core/agent-runtime/tools/context.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const turn = (id: string, sessionKey = "chat") => new RequestContext({ sessionKey, metadata: { turnId: id } });

describe("permission preflight before opening the target app", () => {
  it("blocks WeChat and all subsequent tools until the user sends a new message", async () => {
    const read = vi.fn().mockResolvedValueOnce({ state: "missing", permission: "accessibility" }).mockResolvedValue({ state: "granted" });
    const gate = new MacPermissionPreflight(read);
    const show = vi.spyOn(macPermissionSettingsGuide, "show").mockResolvedValue(true);
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "WeChat opened" }] });
    const snapshot = new MCPToolWrapper({ callTool }, "open_computer_use", { name: "get_app_state" }, 30, gate);
    const click = new MCPToolWrapper({ callTool }, "open_computer_use", { name: "click" }, 30, gate);
    snapshot.setContext(turn("first")); click.setContext(turn("first"));
    expect(await snapshot.execute({ app: "WeChat" })).toContain("operation was not executed");
    expect(show).not.toHaveBeenCalled(); // Native doctor already owns onboarding.
    // read would now return granted, but the current turn must remain blocked.
    await click.execute({ app: "WeChat" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(callTool).not.toHaveBeenCalled();
    snapshot.setContext(turn("next-user-message"));
    await snapshot.execute({ app: "WeChat" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenCalledExactlyOnceWith("get_app_state", { app: "WeChat" }, 30);
  });
  it("awaits one shared check for concurrent calls before sending either target", async () => {
    let finish!: (status: any) => void;
    const read = vi.fn(() => new Promise<any>((resolve) => { finish = resolve; }));
    const gate = new MacPermissionPreflight(read);
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    const tools = ["click", "type_text"].map((name) => new MCPToolWrapper({ callTool }, "open_computer_use", { name }, 30, gate));
    for (const tool of tools) tool.setContext(turn("same"));
    const pending = tools.map((tool) => tool.execute({ app: "WeChat" }));
    await Promise.resolve(); expect(callTool).not.toHaveBeenCalled();
    finish({ state: "granted" }); await Promise.all(pending);
    expect(read).toHaveBeenCalledTimes(1); expect(callTool).toHaveBeenCalledTimes(2);
  });
  it("fails closed when permissions cannot be verified", async () => {
    const gate = new MacPermissionPreflight(async () => ({ state: "unknown" }));
    const callTool = vi.fn();
    const show = vi.spyOn(macPermissionSettingsGuide, "show").mockResolvedValue(true);
    const tool = new MCPToolWrapper({ callTool }, "open_computer_use", { name: "get_app_state" }, 30, gate);
    expect(await tool.execute({ app: "WeChat" })).toContain("could not verify");
    expect(callTool).not.toHaveBeenCalled(); expect(show).not.toHaveBeenCalled();
  });
  it("blocks later calls if the native runtime denies access after preflight", async () => {
    const gate = new MacPermissionPreflight(async () => ({ state: "granted" }));
    vi.spyOn(macPermissionSettingsGuide, "show").mockResolvedValue(true);
    const callTool = vi.fn().mockResolvedValue({ isError: true, content: [{ type: "text", text: "Accessibility permission is required." }] });
    const tool = new MCPToolWrapper({ callTool }, "open_computer_use", { name: "click" }, 30, gate);
    tool.setContext(turn("first"));
    await tool.execute({ app: "WeChat" }); await tool.execute({ app: "WeChat" });
    expect(callTool).toHaveBeenCalledTimes(1);
  });
  it("separates chat sessions even if message IDs match", async () => {
    const read = vi.fn().mockResolvedValue({ state: "granted" });
    const gate = new MacPermissionPreflight(read);
    await gate.check(turn("same-id", "one")); await gate.check(turn("same-id", "two"));
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not prompt for background continuations using the original user channel", async () => {
    const read = vi.fn().mockResolvedValue({ state: "granted" });
    const gate = new MacPermissionPreflight(read);
    expect(await gate.check(new RequestContext({ channel: "websocket", messageId: "continuation", metadata: { computerUseInteractive: false } }))).toEqual({ state: "unknown" });
    expect(read).not.toHaveBeenCalled();
  });
  it("blocks same-turn retries after a native restart with an uncertain action result", async () => {
    const read = vi.fn().mockResolvedValue({ state: "granted" });
    const gate = new MacPermissionPreflight(read);
    const callTool = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("MCP error -32000: Computer Use connection changed."), { code: -32000 }))
      .mockResolvedValue({ content: [] });
    const tool = new MCPToolWrapper({ callTool }, "open_computer_use", { name: "click" }, 30, gate);
    tool.setContext(turn("before-restart"));
    expect(await tool.execute({ app: "WeChat" })).toContain("result is unknown");
    expect(await tool.execute({ app: "WeChat" })).toContain("operation was not executed");
    expect(callTool).toHaveBeenCalledTimes(1);
    tool.setContext(turn("new-user-message"));
    await tool.execute({ app: "WeChat" });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("native doctor", () => {
  it.each([
    ["Permissions: accessibility=granted, screenRecording=granted\n", { state: "granted" }],
    ["Permissions: accessibility=missing, screenRecording=missing\n", { state: "missing", permission: "accessibility", missingPermissions: ["accessibility", "screenRecording"] }],
    ["Permissions: accessibility=granted, screenRecording=missing\n", { state: "missing", permission: "screenRecording", missingPermissions: ["screenRecording"] }],
    ["malformed", { state: "unknown" }],
  ])("parses %s", (text, expected) => { expect(parsePermissionDoctor(text)).toEqual(expected); });
  it("preserves the launcher, prefix arguments, cwd and native environment", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-doctor-")); roots.push(root);
    const script = path.join(root, "launcher.cjs"), output = path.join(root, "observed.json");
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),namespace:process.env.OPEN_COMPUTER_USE_APP_AGENT_NAMESPACE})); console.log('Permissions: accessibility=granted, screenRecording=granted');`);
    const read = nativePermissionDoctor({ command: process.execPath, args: [script, "mcp"], env: { OPEN_COMPUTER_USE_APP_AGENT_NAMESPACE: "fixture" }, cwd: root });
    expect(await read()).toEqual({ state: "granted" });
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual({ args: ["doctor"], cwd: fs.realpathSync(root), namespace: "fixture" });
  });
  it("does not invent a doctor command for an incompatible custom launcher", async () => {
    expect(await nativePermissionDoctor({ command: "/nonexistent", args: ["custom"], env: null, cwd: null })()).toEqual({ state: "unknown" });
  });
});

it("does not execute the target if the user cancels during the permission check", async () => {
  const controller = new AbortController();
  const gate = new MacPermissionPreflight(async () => { controller.abort(); return {state: "granted"}; });
  const callTool = vi.fn();
  const tool = new MCPToolWrapper({callTool}, "open_computer_use", {name: "get_app_state"}, 30, gate);
  tool.setContext(turn("cancelled"));
  expect(await tool.execute({app: "WeChat"}, {abortSignal: controller.signal})).toContain("cancelled");
  expect(callTool).not.toHaveBeenCalled();
});
