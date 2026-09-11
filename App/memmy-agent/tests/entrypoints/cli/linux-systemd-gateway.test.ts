import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { Config } from "../../../src/config/schema.js";
import {
  hasUsableDefaultModel,
  prepareLinuxGatewayConfig,
  prepareSystemdGatewayEnvironment,
  probeGateway,
  probeMemoryServiceAuthentication,
  runLinuxRootTerminal,
  type GatewayProbe,
} from "../../../src/entrypoints/cli/linux-systemd-gateway.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function configured(): Config {
  return new Config({
    agents: { defaults: { model: "ollama/llama3.2" } },
    channels: {
      websocket: {
        enabled: true,
        host: "127.0.0.1",
        port: 18980,
        tokenIssueSecret: "secret",
      },
    },
  });
}

function bootstrapResponse(status = 200): Response {
  return new Response(JSON.stringify({
    token: "gateway-token",
    ws_path: "/",
    expires_in: 300,
    model_name: "test-model",
    model_selection: null,
    tool_names: [],
  }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function refused(): TypeError {
  const error = new TypeError("fetch failed") as TypeError & { cause?: NodeJS.ErrnoException };
  error.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  return error;
}

describe("Linux systemd Gateway probing", () => {
  it("uses the configured bootstrap secret and accepts only a compatible response", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ authorization: "Bearer secret" });
      return bootstrapResponse();
    }) as unknown as typeof fetch;

    await expect(probeGateway(configured(), { fetchImpl })).resolves.toEqual({ status: "ready" });
  });

  it("distinguishes a refused connection from authentication and protocol conflicts", async () => {
    const unavailableFetch = vi.fn(async () => {
      throw refused();
    }) as unknown as typeof fetch;
    const unauthorizedFetch = vi.fn(
      async () => new Response("Unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;
    const invalidFetch = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    await expect(probeGateway(configured(), { fetchImpl: unavailableFetch })).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(probeGateway(configured(), { fetchImpl: unauthorizedFetch })).resolves.toEqual({
      status: "unexpected",
      detail: "bootstrap HTTP 401",
    });
    await expect(probeGateway(configured(), { fetchImpl: invalidFetch })).resolves.toEqual({
      status: "unexpected",
      detail: "bootstrap response is incompatible",
    });
  });

  it("treats a disabled WebSocket channel as requiring service configuration", async () => {
    await expect(probeGateway(new Config(), {
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })).resolves.toMatchObject({
      status: "unavailable",
      detail: expect.stringContaining("WebSocket Gateway is disabled"),
    });
  });

  it("treats a probe timeout as temporarily unavailable", async () => {
    const timedOutFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("timed out", "AbortError"));
        });
      });
      return bootstrapResponse();
    }) as unknown as typeof fetch;

    await expect(probeGateway(configured(), {
      fetchImpl: timedOutFetch,
      timeoutMs: 1,
    })).resolves.toMatchObject({ status: "unavailable" });
  });
});

describe("Linux systemd Memory authentication probing", () => {
  it("uses the configured Memory token and rejects a stale service token", async () => {
    const config = new Config({
      memmyMemory: {
        storage: {
          endpoint: "http://127.0.0.1:18960",
          token: "current-memory-token",
        },
      },
    });
    const readyFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ authorization: "Bearer current-memory-token" });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const staleFetch = vi.fn(async () => new Response("Unauthorized", {
      status: 401,
    })) as unknown as typeof fetch;

    await expect(probeMemoryServiceAuthentication(config, { fetchImpl: readyFetch }))
      .resolves.toEqual({ status: "ready" });
    await expect(probeMemoryServiceAuthentication(config, { fetchImpl: staleFetch }))
      .resolves.toEqual({
        status: "unexpected",
        detail: "authenticated Memory HTTP 401",
      });
  });
});

describe("Linux systemd Gateway configuration", () => {
  it("enables localhost defaults without overwriting custom endpoints", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-linux-systemd-config-"));
    temporaryRoots.push(root);
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      channels: { websocket: { enabled: false, host: "127.0.0.2", port: 29999 } },
      gateway: { enabled: false, host: "127.0.0.3", port: 29998 },
      futureSection: { keep: true },
    }));
    const load = () => new Config(YAML.parse(readFileSync(configPath, "utf8")));

    const result = await prepareLinuxGatewayConfig(load, configPath);
    const saved = YAML.parse(readFileSync(configPath, "utf8"));

    expect(saved).toMatchObject({
      channels: {
        websocket: {
          enabled: true,
          host: "127.0.0.2",
          port: 29999,
          websocketRequiresToken: true,
        },
      },
      gateway: { enabled: true, host: "127.0.0.3", port: 29998 },
      futureSection: { keep: true },
    });
    expect(saved.channels.websocket.tokenIssueSecret).toMatch(/^[a-f0-9]{64}$/);
    expect((result.channels as unknown as { websocket: Record<string, unknown> }).websocket)
      .toMatchObject({ host: "127.0.0.2", port: 29999 });
  });

  it("persists referenced credentials and runtime PATH in a private environment file", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-linux-systemd-env-"));
    temporaryRoots.push(root);
    const configPath = join(root, "config.yaml");
    const destination = join(root, "private", "gateway.env");
    writeFileSync(configPath, [
      "providers:",
      "  custom:",
      "    apiKey: ${CUSTOM_PROVIDER_TOKEN}",
      "    apiBase: ${CUSTOM_API_BASE:https://fallback.invalid}",
      "",
    ].join("\n"));
    const env = {
      PATH: "/home/test/bin:/usr/bin",
      CUSTOM_PROVIDER_TOKEN: 'secret with spaces and "quotes"',
      OPENAI_API_KEY: "implicit-openai-key",
    };

    await expect(prepareSystemdGatewayEnvironment({
      configPath,
      destination,
      env,
    })).resolves.toBe(true);
    const saved = readFileSync(destination, "utf8");
    expect(saved).toContain('PATH="/home/test/bin:/usr/bin"');
    expect(saved).toContain('CUSTOM_PROVIDER_TOKEN="secret with spaces and \\"quotes\\""');
    expect(saved).toContain('OPENAI_API_KEY="implicit-openai-key"');
    expect(saved).not.toContain("CUSTOM_API_BASE=");
    expect(statSync(destination).mode & 0o777).toBe(0o600);

    await expect(prepareSystemdGatewayEnvironment({
      configPath,
      destination,
      env,
    })).resolves.toBe(false);
  });

  it("rejects multiline values instead of emitting an injectable EnvironmentFile", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-linux-systemd-env-invalid-"));
    temporaryRoots.push(root);
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, "apiKey: ${CUSTOM_PROVIDER_TOKEN}\n");

    await expect(prepareSystemdGatewayEnvironment({
      configPath,
      destination: join(root, "gateway.env"),
      env: { CUSTOM_PROVIDER_TOKEN: "first\nsecond" },
    })).rejects.toThrow("contains a newline or NUL");
  });
});

describe("Linux systemd Gateway root terminal flow", () => {
  it("runs onboarding, enables the user service, waits for readiness, and leaves it running", async () => {
    let current = new Config();
    let serviceRunning = false;
    const prepared = configured();
    const order: string[] = [];
    const probes: GatewayProbe[] = [
      { status: "unavailable", detail: "disabled" },
      { status: "unavailable", detail: "connection refused" },
      { status: "unavailable", detail: "starting" },
      { status: "ready" },
    ];

    await runLinuxRootTerminal({
      platform: "linux",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      systemdGatewayEnabled: true,
      loadConfig: () => current,
      onboardWizard: async () => {
        order.push("wizard");
        current = configured();
      },
      prepareGatewayConfig: async () => {
        order.push("prepare");
        current = prepared;
        return prepared;
      },
      refreshMemoryService: async (config) => {
        order.push("memory");
        expect(config).toBe(prepared);
      },
      prepareGatewayEnvironment: async () => {
        order.push("environment");
        return true;
      },
      enableGatewayService: async (options) => {
        order.push(`systemd:${String(options?.restart)}`);
        serviceRunning = true;
      },
      probeGateway: vi.fn(async (): Promise<GatewayProbe> => probes.shift() ?? { status: "ready" }),
      gatewayServiceMainPid: vi.fn(async () => serviceRunning ? 123 : null),
      sleep: async () => undefined,
      runInteractive: async (config) => {
        order.push("tui");
        expect(config).toBe(prepared);
        return null;
      },
    });

    expect(order).toEqual([
      "wizard",
      "prepare",
      "memory",
      "environment",
      "systemd:true",
      "tui",
    ]);
  });

  it("keeps systemd ownership and restarts when the persisted environment changes", async () => {
    const config = configured();
    const prepareGatewayConfig = vi.fn(async () => config);
    const refreshMemoryService = vi.fn(async () => undefined);
    const enableGatewayService = vi.fn(async () => undefined);
    const runInteractive = vi.fn(async () => null);

    await runLinuxRootTerminal({
      platform: "linux",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      systemdGatewayEnabled: true,
      loadConfig: () => config,
      onboardWizard: vi.fn(),
      prepareGatewayConfig,
      refreshMemoryService,
      prepareGatewayEnvironment: async () => true,
      enableGatewayService,
      probeGateway: vi.fn(async (): Promise<GatewayProbe> => ({ status: "ready" })),
      gatewayServiceMainPid: vi.fn(async () => 456),
      sleep: async () => undefined,
      runInteractive,
    });

    expect(prepareGatewayConfig).not.toHaveBeenCalled();
    expect(refreshMemoryService).not.toHaveBeenCalled();
    expect(enableGatewayService).toHaveBeenCalledWith({ restart: true });
    expect(runInteractive).toHaveBeenCalledWith(config);
  });

  it("refuses to take over a compatible Gateway not owned by the user service", async () => {
    const enableGatewayService = vi.fn(async () => undefined);

    await expect(runLinuxRootTerminal({
      platform: "linux",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      systemdGatewayEnabled: true,
      loadConfig: configured,
      onboardWizard: vi.fn(),
      prepareGatewayEnvironment: async () => false,
      enableGatewayService,
      probeGateway: vi.fn(async (): Promise<GatewayProbe> => ({ status: "ready" })),
      gatewayServiceMainPid: vi.fn(async () => null),
      runInteractive: vi.fn(async () => null),
    })).rejects.toThrow("already running outside memmy-gateway.service");

    expect(enableGatewayService).not.toHaveBeenCalled();
  });

  it("does not start over an incompatible or unauthorized external endpoint", async () => {
    const enableGatewayService = vi.fn(async () => undefined);

    await expect(runLinuxRootTerminal({
      platform: "linux",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      systemdGatewayEnabled: true,
      loadConfig: configured,
      onboardWizard: vi.fn(),
      prepareGatewayEnvironment: async () => false,
      enableGatewayService,
      probeGateway: vi.fn(async (): Promise<GatewayProbe> => ({
        status: "unexpected",
        detail: "bootstrap HTTP 401",
      })),
      gatewayServiceMainPid: vi.fn(async () => null),
      runInteractive: vi.fn(async () => null),
    })).rejects.toThrow("occupied, incompatible, or rejected authentication");

    expect(enableGatewayService).not.toHaveBeenCalled();
  });

  it("leaves source-built Linux, non-Linux, and non-TTY invocations unchanged", async () => {
    const loadConfig = vi.fn(configured);
    const runInteractive = vi.fn(async () => null);

    await runLinuxRootTerminal({
      platform: "linux",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      systemdGatewayEnabled: false,
      loadConfig,
      onboardWizard: vi.fn(),
      runInteractive,
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(runInteractive).toHaveBeenCalledWith();
  });

  it("detects whether a usable model is configured", () => {
    expect(hasUsableDefaultModel(configured())).toBe(true);
    expect(hasUsableDefaultModel(new Config())).toBe(false);
  });
});
