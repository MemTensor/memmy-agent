import { expect, it, vi } from "vitest";
import { createConnectionCompensation, type ConnectionEvent } from "../connection-compensation.js";

it("does not let an event-less authority response undo an observed newer disconnect", async () => {
  let event: ConnectionEvent | undefined = { id: "before-auto", revision: 1, state: "connected", kind: "plugin" };
  const connection = createConnectionCompensation(async () => event);
  const baseline = await connection.capture("opencode");
  const reconnect = await connection.begin("opencode", "connected", "plugin");
  event = { id: "local-reconnect", revision: 2, state: "connected", kind: "plugin" };
  connection.record(reconnect, event);
  await connection.settle(reconnect, true);
  let installed = true;
  const install = vi.fn(async () => { installed = true; });
  const commits: Array<string | undefined> = [];
  await connection.compensate("opencode", baseline, {
    install,
    remove: [async () => {
      installed = false;
      // A legacy endpoint/temporarily missing event offers no newer fact.
      event = undefined;
    }],
    commit: async decision => {
      commits.push(decision.kind);
      if (decision.kind) event = { id: "later-remote-disconnect", revision: 3, state: "disconnected", kind: "plugin" };
    }
  });
  expect(installed).toBe(false);
  expect(install).not.toHaveBeenCalled();
  expect(commits).toEqual(["plugin", undefined]);
});

it.each([false, true])("does not override a later disconnect when local connect completion is delayed, legacy=%s", async legacy => {
  let event: ConnectionEvent | undefined;
  const connection = createConnectionCompensation(async () => event);
  const connecting = await connection.begin("opencode", "connected", "plugin");
  if (!legacy) {
    connection.record(connecting, { id: "connect", revision: 1, state: "connected", kind: "plugin" });
    event = { id: "later-disconnect", revision: 2, state: "disconnected", kind: "plugin" };
  }
  const baseline = await connection.capture("opencode");
  connection.settle(connecting, true);
  let installed = true;
  await connection.compensate("opencode", baseline, {
    remove: [async () => { installed = false; }],
    install: async () => { installed = true; },
    commit: async () => {}
  });
  expect(installed).toBe(legacy);
});

it.each(["outage", "old-response"])("keeps a local committed disconnect newer than cached reconnect during %s", async readFailure => {
  const original: ConnectionEvent = { id: "before", revision: 1, state: "connected", kind: "plugin" };
  const reconnect: ConnectionEvent = { id: "reconnect", revision: 2, state: "connected", kind: "plugin" };
  let event: ConnectionEvent = original;
  let broken = false;
  const connection = createConnectionCompensation(async () => {
    if (broken && readFailure === "outage") throw new Error("offline");
    return broken ? reconnect : event;
  });
  const baseline = await connection.capture("opencode");
  let installed = true;
  let interrupted = false;
  await connection.compensate("opencode", baseline, {
    remove: [async () => {
      installed = false;
      if (!interrupted) { event = reconnect; interrupted = true; }
    }],
    install: async () => {
      installed = true;
      const disconnecting = await connection.begin("opencode", "disconnected", "plugin");
      event = { id: "disconnect", revision: 3, state: "disconnected", kind: "plugin" };
      connection.record(disconnecting, event);
      // The disconnect committed, but its final local display-state save failed.
      connection.settle(disconnecting, false);
      broken = true;
    },
    commit: async () => {}
  });
  expect(installed).toBe(false);
});

it("does not let failed disconnect settlement consume a later committed reconnect", async () => {
  let event: ConnectionEvent = { id: "before", revision: 1, state: "connected", kind: "plugin" };
  const connection = createConnectionCompensation(async () => event);
  const baseline = await connection.capture("opencode");
  let installed = true;
  await connection.compensate("opencode", baseline, {
    remove: [async () => {
      const disconnecting = await connection.begin("opencode", "disconnected", "plugin");
      event = { id: "disconnect", revision: 2, state: "disconnected", kind: "plugin" };
      connection.record(disconnecting, event);
      event = { id: "later-reconnect", revision: 3, state: "connected", kind: "plugin" };
      installed = true;
      connection.settle(disconnecting, false);
      installed = false;
    }],
    install: async () => { installed = true; },
    commit: async () => {}
  });
  expect(installed).toBe(true);
});
