import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { excelBridge, type ExcelBridge } from "./excel-bridge.js";
import { prepareLocalExcelAddin, readLocalExcelTls, refreshLocalExcelAddinManifest } from "./excel-addin-setup.js";

const DEFAULT_PORT = 32177;
const MAX_BODY = 600_000;

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

export function excelAddinManifest(port = DEFAULT_PORT): string {
  const base = `https://localhost:${port}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0" xsi:type="TaskPaneApp">
  <Id>9d36b812-9514-4f28-93fd-5c293a8746e2</Id>
  <Version>1.0.0.1</Version>
  <ProviderName>Memmy</ProviderName>
  <DefaultLocale>zh-CN</DefaultLocale>
  <DisplayName DefaultValue="Memmy Excel"/>
  <Description DefaultValue="Connect this Excel workbook to the local Memmy assistant."/>
  <IconUrl DefaultValue="${xmlEscape(base)}/icon.png"/>
  <HighResolutionIconUrl DefaultValue="${xmlEscape(base)}/icon.png"/>
  <SupportUrl DefaultValue="https://memmy.app"/>
  <AppDomains><AppDomain>${xmlEscape(base)}</AppDomain></AppDomains>
  <Hosts><Host Name="Workbook"/></Hosts>
  <DefaultSettings><SourceLocation DefaultValue="${xmlEscape(base)}/taskpane"/></DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="Workbook">
        <DesktopFormFactor>
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="MemmyGroup">
                <Label resid="MemmyGroup.Label"/>
                <Icon>
                  <bt:Image size="16" resid="Icon.16"/>
                  <bt:Image size="32" resid="Icon.32"/>
                  <bt:Image size="80" resid="Icon.80"/>
                </Icon>
                <Control xsi:type="Button" id="MemmyTaskpaneButton">
                  <Label resid="MemmyButton.Label"/>
                  <Supertip>
                    <Title resid="MemmyButton.Label"/>
                    <Description resid="MemmyButton.Tooltip"/>
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Icon.16"/>
                    <bt:Image size="32" resid="Icon.32"/>
                    <bt:Image size="80" resid="Icon.80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>MemmyTaskpane</TaskpaneId>
                    <SourceLocation resid="Taskpane.Url"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
        <bt:Image id="Icon.16" DefaultValue="${xmlEscape(base)}/icon.png"/>
        <bt:Image id="Icon.32" DefaultValue="${xmlEscape(base)}/icon.png"/>
        <bt:Image id="Icon.80" DefaultValue="${xmlEscape(base)}/icon.png"/>
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Taskpane.Url" DefaultValue="${xmlEscape(base)}/taskpane"/>
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="MemmyGroup.Label" DefaultValue="Memmy"/>
        <bt:String id="MemmyButton.Label" DefaultValue="Memmy"/>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="MemmyButton.Tooltip" DefaultValue="Open Memmy in Excel"/>
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>`;
}

const TASKPANE_SCRIPT = String.raw`
(function () {
  "use strict";
  const token = window.__MEMMY_EXCEL_TOKEN__;
  const status = document.getElementById("status");
  const sessionId = crypto.randomUUID();
  let running = true;
  function show(message) { status.textContent = message; }
  async function api(path, method = "GET", body) {
    const response = await fetch(path, {
      method,
      headers: { "X-Memmy-Excel-Token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Local Memmy bridge: " + response.status);
    return response.json();
  }
  async function runCommand(command) {
    return Excel.run(async context => {
      if (command.kind === "selection") {
        const range = context.workbook.getSelectedRange();
        range.load(["address", "rowCount", "columnCount"]);
        await context.sync();
        return { address: range.address, rows: range.rowCount, columns: range.columnCount };
      }
      const sheet = command.sheet
        ? context.workbook.worksheets.getItem(command.sheet)
        : context.workbook.worksheets.getActiveWorksheet();
      const range = sheet.getRange(command.address);
      range.load(["address", "rowCount", "columnCount"]);
      await context.sync();
      if (range.rowCount * range.columnCount > 10000) throw new Error("Range exceeds 10,000 cells");
      if (command.kind === "read_range") {
        range.load("values");
        await context.sync();
        const data = { address: range.address, values: range.values };
        if (JSON.stringify(data).length > 500000) throw new Error("Range result is too large");
        return data;
      }
      if (command.kind === "write_range") {
        if (range.rowCount !== command.values.length || range.columnCount !== command.values[0].length) {
          throw new Error("Value dimensions do not match the selected range");
        }
        range.values = command.values;
        await context.sync();
        return { address: range.address, rows: range.rowCount, columns: range.columnCount };
      }
      throw new Error("Unsupported Excel command");
    });
  }
  async function loop() {
    while (running) {
      try {
        await api("/api/heartbeat", "POST", { sessionId });
        const { command } = await api("/api/next?sessionId=" + encodeURIComponent(sessionId));
        if (command) {
          try {
            const data = await runCommand(command);
            await api("/api/result", "POST", { sessionId, id: command.id, ok: true, data });
          } catch (error) {
            await api("/api/result", "POST", {
              sessionId, id: command.id, ok: false,
              error: String(error && error.message || error).slice(0, 500),
            });
          }
        }
        show("Connected to Memmy. Keep this task pane open while working.");
      } catch (error) {
        show("Waiting for the local Memmy bridge. Check that Memmy is running and its certificate is trusted.");
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  window.addEventListener("pagehide", () => { running = false; });
  Office.onReady(info => {
    if (info.host !== Office.HostType.Excel) {
      show("Open this add-in inside Microsoft Excel.");
      return;
    }
    void loop();
  });
})();
`;

function taskpaneHtml(token: string): string {
  const nonce = randomBytes(16).toString("base64");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Memmy Excel</title><style>body{font:14px system-ui;padding:18px;color:#242a36}h1{font-size:20px}#status{line-height:1.5}</style>
<script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>
<script nonce="${nonce}">window.__MEMMY_EXCEL_TOKEN__=${JSON.stringify(token)};</script>
<script defer src="/taskpane.js"></script></head><body><h1>Memmy Excel</h1><p id="status">Connecting…</p></body></html>`;
}

function iconPng(): Buffer {
  // Keep the ribbon self-contained. Office validates the icon bytes while it
  // parses VersionOverrides, so this must be a complete PNG (including IEND).
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOklEQVR42u3XsQ0AIAgAQeZxRjemcwGcwkjCFd9f+5Gn6mcB0A6w9tsAAAAAAAAAAAAAAPoDnNE4wAVwobD148dQAgAAAABJRU5ErkJggg==", "base64");
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value as Record<string, unknown>;
}

export class ExcelAddinServer {
  private server: https.Server | null = null;
  private token = "";
  constructor(private readonly bridge: ExcelBridge = excelBridge) {}

  get running(): boolean { return this.server !== null; }

  async start(options: { certPath?: string; keyPath?: string; pfxPath?: string; pfxPassword?: string; port?: number }): Promise<void> {
    if (this.server) return;
    const port = options.port ?? DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid Excel add-in port");
    const certificate = options.pfxPath
      ? { pfx: await readFile(options.pfxPath), passphrase: options.pfxPassword ?? "" }
      : options.certPath && options.keyPath
        ? { cert: await readFile(options.certPath), key: await readFile(options.keyPath) }
        : null;
    if (!certificate) throw new Error("Excel add-in TLS certificate is not configured");
    this.token = randomBytes(32).toString("hex");
    let server: https.Server;
    try {
      server = https.createServer(certificate, (request, response) => {
        void this.handle(request, response, port).catch(error => {
          this.reply(response, 400, { error: String(error?.message ?? error) });
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Excel localhost certificate could not be loaded (${message})`);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      this.server = server;
      this.bridge.setConfigured(true);
    } catch (error) {
      server.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.bridge.setConfigured(false);
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private reply(response: ServerResponse, status: number, data: unknown): void {
    if (response.headersSent) return;
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(data));
  }

  private async handle(request: IncomingMessage, response: ServerResponse, port: number): Promise<void> {
    if (request.headers.host !== `localhost:${port}`) return this.reply(response, 403, { error: "Invalid host" });
    if (request.headers.origin && request.headers.origin !== `https://localhost:${port}`) {
      return this.reply(response, 403, { error: "Invalid origin" });
    }
    const url = new URL(request.url ?? "/", `https://localhost:${port}`);
    if (request.method === "GET" && url.pathname === "/manifest.xml") {
      response.writeHead(200, { "Content-Type": "application/xml", "Cache-Control": "no-store" });
      response.end(excelAddinManifest(port));
      return;
    }
    if (request.method === "GET" && url.pathname === "/icon.png") {
      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public,max-age=86400" });
      response.end(iconPng());
      return;
    }
    if (request.method === "GET" && url.pathname === "/taskpane") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline' https://appsforoffice.microsoft.com; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'",
      });
      response.end(taskpaneHtml(this.token));
      return;
    }
    if (request.method === "GET" && url.pathname === "/taskpane.js") {
      response.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
      });
      response.end(TASKPANE_SCRIPT);
      return;
    }
    if (request.headers["x-memmy-excel-token"] !== this.token) return this.reply(response, 403, { error: "Invalid bridge token" });
    if (request.method === "POST" && url.pathname === "/api/heartbeat") {
      const body = await readJson(request);
      this.bridge.heartbeat(String(body.sessionId ?? ""));
      return this.reply(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/api/next") {
      return this.reply(response, 200, { command: this.bridge.next(url.searchParams.get("sessionId") ?? "") });
    }
    if (request.method === "POST" && url.pathname === "/api/result") {
      const body = await readJson(request);
      if (typeof body.id !== "string" || typeof body.ok !== "boolean") throw new Error("Invalid Excel result");
      const accepted = this.bridge.complete(String(body.sessionId ?? ""), body.id, {
        ok: body.ok, data: body.data, error: typeof body.error === "string" ? body.error : undefined,
      });
      return this.reply(response, accepted ? 200 : 404, { accepted });
    }
    this.reply(response, 404, { error: "Not found" });
  }
}

export const excelAddinServer = new ExcelAddinServer();

export async function enableLocalExcelAddin(): Promise<void> {
  const setup = await prepareLocalExcelAddin();
  await excelAddinServer.start({ ...setup.tls, port: Number(process.env.MEMMY_EXCEL_ADDIN_PORT || DEFAULT_PORT) });
}

export async function startConfiguredExcelAddinServer(): Promise<void> {
  const certPath = process.env.MEMMY_EXCEL_ADDIN_TLS_CERT;
  const keyPath = process.env.MEMMY_EXCEL_ADDIN_TLS_KEY;
  const pfxPath = process.env.MEMMY_EXCEL_ADDIN_TLS_PFX;
  const saved = await readLocalExcelTls();
  if (!pfxPath && (!certPath || !keyPath) && !saved) return;
  await refreshLocalExcelAddinManifest();
  await excelAddinServer.start({
    certPath: certPath && keyPath ? certPath : saved?.certPath,
    keyPath: certPath && keyPath ? keyPath : saved?.keyPath,
    pfxPath: pfxPath ?? saved?.pfxPath,
    pfxPassword: pfxPath ? process.env.MEMMY_EXCEL_ADDIN_TLS_PFX_PASSWORD : saved?.pfxPassword,
    port: Number(process.env.MEMMY_EXCEL_ADDIN_PORT || DEFAULT_PORT),
  });
}
