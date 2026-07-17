export type WsRawMessage = Record<string, any>;

export class WsMessage {
  constructor(
    public event: string,
    public raw: WsRawMessage,
  ) {}

  get text(): string | null {
    return this.raw.text ?? null;
  }

  get chatId(): string | null {
    return this.raw.chat_id ?? this.raw.chatId ?? null;
  }

  get clientId(): string | null {
    return this.raw.client_id ?? this.raw.clientId ?? null;
  }

  get media(): string[] | null {
    return this.raw.media ?? null;
  }

  get replyTo(): string | null {
    return this.raw.reply_to ?? this.raw.replyTo ?? null;
  }

  get streamId(): string | null {
    return this.raw.stream_id ?? this.raw.streamId ?? null;
  }

  equals(other: unknown): boolean {
    return (
      other instanceof WsMessage &&
      this.event === other.event &&
      JSON.stringify(this.raw) === JSON.stringify(other.raw)
    );
  }
}

export interface WsTestClientOptions {
  clientId?: string;
  token?: string;
  extraHeaders?: Record<string, string>;
}

export class WsTestClient {
  private readonly uri: string;
  private readonly extraHeaders: Record<string, string> | undefined;
  private wsConn: WebSocket | null = null;
  private pending: string[] = [];
  private waiters: Array<{ resolve: (raw: string) => void; reject: (error: Error) => void }> = [];
  private closeError: Error | null = null;

  constructor(uri: string, options: WsTestClientOptions = {}) {
    const clientId = options.clientId ?? "test-client";
    const token = options.token ?? "";
    const params: string[] = [];
    if (clientId) params.push(`client_id=${encodeURIComponent(clientId)}`);
    if (token) params.push(`token=${encodeURIComponent(token)}`);
    this.uri = params.length ? `${uri}${uri.includes("?") ? "&" : "?"}${params.join("&")}` : uri;
    this.extraHeaders = options.extraHeaders;
  }

  async connect(): Promise<void> {
    if (this.extraHeaders && Object.keys(this.extraHeaders).length > 0) {
      throw new Error("extraHeaders are not supported by the built-in WebSocket test client");
    }
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) throw new Error("global WebSocket is not available in this Node runtime");
    const ws = new WebSocketCtor(this.uri);
    this.wsConn = ws;
    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(raw);
      else this.pending.push(raw);
    });
    ws.addEventListener("close", () => {
      this.closeError = new Error("WebSocket connection closed");
      for (const waiter of this.waiters.splice(0)) waiter.reject(this.closeError);
    });
    ws.addEventListener("error", () => {
      const error = new Error("WebSocket connection error");
      this.closeError = error;
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("WebSocket connection error"));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });
  }

  async close(): Promise<void> {
    if (!this.wsConn) return;
    const ws = this.wsConn;
    this.wsConn = null;
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true });
      ws.close();
    });
  }

  async enter(): Promise<this> {
    await this.connect();
    return this;
  }

  async exit(): Promise<void> {
    await this.close();
  }

  get ws(): WebSocket {
    if (!this.wsConn) throw new Error("Client is not connected");
    return this.wsConn;
  }

  get closed(): boolean {
    return (
      !this.wsConn ||
      this.wsConn.readyState === WebSocket.CLOSED ||
      this.wsConn.readyState === WebSocket.CLOSING
    );
  }

  async recvRaw(timeout = 10): Promise<WsRawMessage> {
    const raw = await this.recvFrame(timeout);
    return JSON.parse(raw);
  }

  async recv(timeout = 10): Promise<WsMessage> {
    const data = await this.recvRaw(timeout);
    return new WsMessage(String(data.event ?? ""), data);
  }

  async recvReady(timeout = 5): Promise<WsMessage> {
    const msg = await this.recv(timeout);
    if (msg.event !== "ready") throw new Error(`Expected 'ready' event, got '${msg.event}'`);
    return msg;
  }

  async recvMessage(timeout = 10): Promise<WsMessage> {
    const msg = await this.recv(timeout);
    if (msg.event !== "message") throw new Error(`Expected 'message' event, got '${msg.event}'`);
    return msg;
  }

  async recvDelta(timeout = 10): Promise<WsMessage> {
    const msg = await this.recv(timeout);
    if (msg.event !== "delta") throw new Error(`Expected 'delta' event, got '${msg.event}'`);
    return msg;
  }

  async recvStreamEnd(timeout = 10): Promise<WsMessage> {
    const msg = await this.recv(timeout);
    if (msg.event !== "stream_end")
      throw new Error(`Expected 'stream_end' event, got '${msg.event}'`);
    return msg;
  }

  async collectStream(timeout = 10): Promise<WsMessage[]> {
    const messages: WsMessage[] = [];
    while (true) {
      const msg = await this.recv(timeout);
      messages.push(msg);
      if (msg.event === "stream_end") break;
    }
    return messages;
  }

  async recvN(n: number, timeout = 10): Promise<WsMessage[]> {
    const messages: WsMessage[] = [];
    for (let i = 0; i < n; i += 1) messages.push(await this.recv(timeout));
    return messages;
  }

  async sendText(text: string): Promise<void> {
    this.ws.send(text);
  }

  async sendJson(data: WsRawMessage): Promise<void> {
    this.ws.send(JSON.stringify(data));
  }

  async sendContent(content: string): Promise<void> {
    await this.sendJson({ content });
  }

  private async recvFrame(timeout: number): Promise<string> {
    if (this.pending.length) return this.pending.shift()!;
    if (this.closeError) throw this.closeError;
    return await withTimeout(
      new Promise<string>((resolve, reject) => this.waiters.push({ resolve, reject })),
      timeout,
      "Timed out waiting for WebSocket message",
    );
  }
}

export async function issueToken(
  host = "127.0.0.1",
  port = 18980,
  issuePath = "/auth/token",
  secret = "",
): Promise<[WsRawMessage | null, number]> {
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const response = await fetch(`http://${host}:${port}${issuePath}`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  let data: WsRawMessage | null = null;
  try {
    data = (await response.json()) as WsRawMessage;
  } catch {
    data = null;
  }
  return [data, response.status];
}

export async function issueTokenOk(
  host = "127.0.0.1",
  port = 18980,
  issuePath = "/auth/token",
  secret = "",
): Promise<string> {
  const [data, status] = await issueToken(host, port, issuePath, secret);
  if (status !== 200) throw new Error(`Token issue failed with status ${status}`);
  if (!data) throw new Error("Token issue response was not JSON");
  const token = data.token;
  if (typeof token !== "string" || !token.startsWith("nbwt_"))
    throw new Error(`Unexpected token format: ${String(token)}`);
  return token;
}

async function withTimeout<T>(promise: Promise<T>, seconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve, reject) => {
        void resolve;
        timer = setTimeout(() => reject(new Error(message)), seconds * 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
