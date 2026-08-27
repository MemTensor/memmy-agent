import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  installGatewaySignalLifecycle,
  type GatewayRuntime,
} from "../../../src/entrypoints/cli/commands.js";

describe("Gateway signal lifecycle", () => {
  it("stops the runtime once before exiting successfully on SIGTERM", async () => {
    const lifecycle = new EventEmitter() as EventEmitter & {
      exit: ReturnType<typeof vi.fn>;
    };
    lifecycle.exit = vi.fn();
    const stop = vi.fn(async () => undefined);
    const runtime = { stop } as unknown as GatewayRuntime;

    installGatewaySignalLifecycle(runtime, lifecycle as never);
    lifecycle.emit("SIGTERM");
    lifecycle.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledTimes(1);
      expect(lifecycle.exit).toHaveBeenCalledWith(0);
    });
  });

  it("exits unsuccessfully when graceful shutdown fails", async () => {
    const lifecycle = new EventEmitter() as EventEmitter & {
      exit: ReturnType<typeof vi.fn>;
    };
    lifecycle.exit = vi.fn();
    const runtime = {
      stop: vi.fn(async () => {
        throw new Error("flush failed");
      }),
    } as unknown as GatewayRuntime;

    installGatewaySignalLifecycle(runtime, lifecycle as never);
    lifecycle.emit("SIGINT");

    await vi.waitFor(() => expect(lifecycle.exit).toHaveBeenCalledWith(1));
  });

});
