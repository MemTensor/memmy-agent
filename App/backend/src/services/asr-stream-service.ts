/**
 * Live ASR stream relay: renderer ⇄ local API ⇄ Memmy Cloud.
 *
 * The renderer cannot talk to the Cloud's `/agentAsr/stream` directly — it
 * holds neither the account credential nor the Cloud origin, and the Cloud's
 * handshake wants the account bearer token, not the local runtime token. So
 * the local API accepts the renderer's WebSocket, authenticates it with the
 * runtime token, opens a second WebSocket to the Cloud with the account
 * credential, and pipes frames both ways without inspecting the audio.
 *
 * Text frames (control and events) are validated at the boundary; binary
 * frames are forwarded as-is. If either side closes, the other is closed with
 * a matching status so a dropped microphone never leaves an upstream task
 * hanging on the Cloud.
 */
import { AsrStreamControlSchema, AsrStreamEventSchema } from "@memmy/local-api-contracts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type { AccountSessionRepository } from "../infrastructure/app-state-store/repositories/account-session-repo.js";
import type { BootstrapRepository } from "../infrastructure/app-state-store/repositories/bootstrap-repo.js";
import type { AppSettingsDto } from "@memmy/local-api-contracts";

export interface AsrStreamService {
  /**
   * Handles an HTTP upgrade for `/api/asr/stream`.
   *
   * Authentication has already happened by the time this is called; the
   * service only has to decide whether the account can stream and then
   * bridge the two sockets.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Closes every open bridge; used on shutdown. */
  close(): Promise<void>;
}

export interface CreateAsrStreamServiceOptions {
  bootstrapRepository: Pick<BootstrapRepository, "getAppSettings"> | { getAppSettings(): Pick<AppSettingsDto, "userMode"> };
  accountSessionRepository: Pick<AccountSessionRepository, "getCloudUuid">;
  /** Cloud API base URL, e.g. `https://test-api.memmy.cn` (no `/api` suffix). */
  cloudBaseUrl: string;
  /** Overrides the upstream socket constructor; tests use it. */
  connectUpstream?: (url: string, headers: Record<string, string>) => WebSocket;
}

/**
 * Every existing Cloud call goes through `/api/...` (see
 * `http-cloud-client.ts`'s `/api/agentAsr/transcriptions`,
 * `/api/agentUser/login`, etc.) — an external gateway in front of the Java
 * service adds that prefix; the service's own Spring mapping is the bare
 * `/agentAsr/...`. This constant is the public path, so it needs the prefix
 * even though `AgentAsrWebSocketConfig.STREAM_PATH` on the Java side does not.
 */
const CLOUD_STREAM_PATH = "/api/agentAsr/stream";
const CLOSE_NORMAL = 1000;
const CLOSE_POLICY = 1008;
const CLOSE_UPSTREAM_GONE = 1011;

/**
 * Creates the live ASR stream relay.
 *
 * @param options Repositories for mode/credential lookup and the Cloud origin.
 * @returns The relay service.
 */
export function createAsrStreamService(options: CreateAsrStreamServiceOptions): AsrStreamService {
  const server = new WebSocketServer({ noServer: true });
  const bridges = new Set<WebSocket>();
  const connectUpstream = options.connectUpstream ?? ((url, headers) => new WebSocket(url, { headers }));

  return {
    handleUpgrade(request, socket, head) {
      server.handleUpgrade(request, socket, head, (downstream) => {
        bridges.add(downstream);
        downstream.once("close", () => bridges.delete(downstream));
        bridge(downstream, options, connectUpstream);
      });
    },

    async close() {
      for (const downstream of bridges) {
        downstream.close(CLOSE_NORMAL, "shutdown");
      }
      bridges.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

/**
 * Turns the Cloud HTTP base URL into its WebSocket stream URL.
 *
 * @param cloudBaseUrl The Cloud API base, with or without a trailing slash.
 * @returns The `wss://` (or `ws://` for loopback stubs) stream endpoint.
 */
export function toCloudStreamUrl(cloudBaseUrl: string): string {
  const url = new URL(cloudBaseUrl.replace(/\/+$/, "") + CLOUD_STREAM_PATH);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

function bridge(
  downstream: WebSocket,
  options: CreateAsrStreamServiceOptions,
  connectUpstream: NonNullable<CreateAsrStreamServiceOptions["connectUpstream"]>
): void {
  const userMode = options.bootstrapRepository.getAppSettings().userMode;
  if (userMode !== "account") {
    // BYOK has no Cloud relay to lean on, and there is no BYOK streaming
    // transport yet; the segmented HTTP path is what that mode gets.
    sendEvent(downstream, { type: "error", message: "Live transcription requires account mode" });
    downstream.close(CLOSE_POLICY, "account mode required");
    return;
  }
  const uuid = options.accountSessionRepository.getCloudUuid();
  if (!uuid) {
    sendEvent(downstream, { type: "error", message: "Cloud account is not authenticated" });
    downstream.close(CLOSE_POLICY, "unauthenticated");
    return;
  }

  const upstream = connectUpstream(toCloudStreamUrl(options.cloudBaseUrl), {
    authorization: `Bearer ${uuid}`,
    "x-agent-region": process.env.MEMMY_APP_EDITION?.trim().toLowerCase() === "intl" ? "intl" : "cn"
  });
  // Frames that arrive before the upstream handshake completes are held, in
  // order, so the first block of speech is not lost to a race.
  const queued: Array<{ data: Buffer; binary: boolean }> = [];
  let upstreamOpen = false;

  const forwardUp = (data: Buffer, binary: boolean) => {
    if (upstreamOpen) upstream.send(data, { binary });
    else queued.push({ data, binary });
  };

  upstream.on("open", () => {
    upstreamOpen = true;
    for (const frame of queued) upstream.send(frame.data, { binary: frame.binary });
    queued.length = 0;
  });

  downstream.on("message", (raw, isBinary) => {
    const data = toBuffer(raw);
    if (isBinary) {
      forwardUp(data, true);
      return;
    }
    // Only well-formed control frames go up; anything else is the renderer's
    // bug and is answered locally rather than handed to the Cloud.
    const parsed = AsrStreamControlSchema.safeParse(safeJson(data.toString("utf8")));
    if (!parsed.success) {
      sendEvent(downstream, { type: "error", message: "invalid control frame" });
      return;
    }
    forwardUp(Buffer.from(JSON.stringify(parsed.data)), false);
  });

  upstream.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const parsed = AsrStreamEventSchema.safeParse(safeJson(toBuffer(raw).toString("utf8")));
    // An event the contract does not know is dropped rather than relayed: the
    // renderer's parser would reject it anyway, and one bad frame must not end
    // the stream.
    if (parsed.success) sendEvent(downstream, parsed.data);
  });

  downstream.on("close", (code, reason) => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close(normalizeCloseCode(code), reason.toString());
    }
  });
  upstream.on("close", (code, reason) => {
    if (downstream.readyState === WebSocket.OPEN) {
      downstream.close(normalizeCloseCode(code), reason.toString());
    }
  });
  upstream.on("error", (error) => {
    if (downstream.readyState === WebSocket.OPEN) {
      sendEvent(downstream, { type: "error", message: `upstream: ${error.message}` });
      downstream.close(CLOSE_UPSTREAM_GONE, "upstream error");
    }
  });
  downstream.on("error", () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close(CLOSE_NORMAL, "downstream error");
    }
  });
}

function sendEvent(socket: WebSocket, event: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

function toBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Only codes the RFC allows an endpoint to send can be echoed to the other side. */
function normalizeCloseCode(code: number): number {
  if (code === 1005 || code === 1006 || code === 1015 || code < 1000 || code > 4999) return CLOSE_NORMAL;
  return code;
}
