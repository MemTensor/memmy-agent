import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { ExcelBridge, validateExcelAction } from "../../../src/tools/computer-use/excel-bridge.js";
import { ExcelAddinServer, excelAddinManifest } from "../../../src/tools/computer-use/excel-addin-server.js";
import { excelSetupFailureMessage, prepareLocalExcelAddin, readExcelManualInstallPath, readLocalExcelTls, refreshLocalExcelAddinManifest, setLocalExcelAddinEnabled } from "../../../src/tools/computer-use/excel-addin-setup.js";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

function request(port: number, route: string, options: {
  method?: string; token?: string; origin?: string; body?: object; binary?: boolean;
} = {}): Promise<{ status: number; body: string | Buffer }> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = https.request({
      hostname: "127.0.0.1", port, path: route, method: options.method ?? "GET",
      rejectUnauthorized: false,
      headers: {
        Host: `localhost:${port}`,
        ...(options.token ? { "X-Memmy-Excel-Token": options.token } : {}),
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, body: options.binary ? raw : raw.toString("utf8") });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("Office.js Excel bridge", () => {
  it.skipIf(process.platform !== "darwin")("prepares a private Mac certificate and Excel sideload after explicit setup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-excel-setup-"));
    const dataDir = path.join(dir, "data");
    const homeDir = path.join(dir, "home");
    const calls: Array<[string, string[]]> = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file, args]);
      if (file === "/usr/bin/openssl") {
        const result = spawnSync(file, args, { stdio: "ignore" });
        expect(result.status).toBe(0);
      }
    };
    try {
      const result = await prepareLocalExcelAddin({ platform: "darwin", dataDir, homeDir, run });
      expect(fs.existsSync(result.tls.certPath!)).toBe(true);
      expect(fs.existsSync(result.tls.keyPath!)).toBe(true);
      expect(fs.statSync(result.tls.keyPath!).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(path.join(homeDir, "Library/Containers/com.microsoft.Excel/Data/Documents/wef/Memmy-Excel.xml"), "utf8"))
        .toContain("https://localhost:32177/taskpane");
      expect(calls.some(([file, args]) => file === "/usr/bin/security" && args.includes("trustRoot"))).toBe(true);
      expect(await readLocalExcelTls(dataDir)).toMatchObject(result.tls);
      fs.writeFileSync(result.manifestPath, "old manifest");
      const refreshed = await refreshLocalExcelAddinManifest({ platform: "darwin", dataDir, homeDir });
      expect(refreshed).toBe(result.manifestPath);
      expect(fs.readFileSync(result.manifestPath, "utf8")).toContain("<Version>1.0.0.1</Version>");
      expect(fs.readFileSync(path.join(homeDir, "Library/Containers/com.microsoft.Excel/Data/Documents/wef/Memmy-Excel.xml"), "utf8"))
        .toContain("<Version>1.0.0.1</Version>");
      await setLocalExcelAddinEnabled(false, dataDir);
      expect(await readLocalExcelTls(dataDir)).toBeNull();
      await prepareLocalExcelAddin({ platform: "darwin", dataDir, homeDir, run });
      expect(await readLocalExcelTls(dataDir)).toMatchObject(result.tls);
      expect(calls.filter(([file]) => file === "/usr/bin/openssl")).toHaveLength(1);
      calls.length = 0;
      const denied = Object.assign(new Error("protected"), { code: "EPERM" as const });
      await prepareLocalExcelAddin({ platform: "darwin", dataDir, homeDir, run, copyFile: async () => { throw denied; } });
      expect(calls.some(([file]) => file === "/usr/bin/open")).toBe(false);
      expect(fs.readFileSync(path.join(dataDir, "computer-use/excel-addin/setup.json"), "utf8")).toContain('"containerSideload":false');
      expect(await readExcelManualInstallPath(dataDir)).toBe(result.manifestPath);
      expect(await refreshLocalExcelAddinManifest({ platform: "darwin", dataDir, homeDir, run, copyFile: async () => { throw denied; } }))
        .toBe(result.manifestPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers the Excel manifest under the Windows current user only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-excel-win-setup-"));
    const dataDir = path.join(dir, "data");
    const calls: Array<[string, string[]]> = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file, args]);
      if (file === "powershell.exe") {
        const setupDir = args.at(-1)!;
        fs.writeFileSync(path.join(setupDir, "localhost.pfx"), "test");
        fs.writeFileSync(path.join(setupDir, "pfx-password.txt"), "test-password");
        fs.writeFileSync(path.join(setupDir, "pfx-format.txt"), "AES256_SHA256");
      }
    };
    try {
      const result = await prepareLocalExcelAddin({ platform: "win32", dataDir, run });
      expect(result.tls.pfxPassword).toBe("test-password");
      const powershell = calls.find(([file]) => file === "powershell.exe")?.[1] ?? [];
      expect(powershell).not.toContain("-NonInteractive");
      expect(calls.find(([file]) => file === "reg.exe")?.[1]).toEqual(expect.arrayContaining([
        "HKCU\\Software\\Microsoft\\Office\\16.0\\WEF\\Developer",
        "9d36b812-9514-4f28-93fd-5c293a8746e2",
        result.manifestPath,
      ]));
      const script = fs.readFileSync(path.join(dataDir, "computer-use/excel-addin/setup-localhost.ps1"), "utf8");
      expect(script).toContain("-DnsName 'localhost'");
      expect(script).toContain("X509Store('Root', 'CurrentUser')");
      expect(script).toContain("Export-PfxCertificate");
      expect(script).toContain("-CryptoAlgorithmOption AES256_SHA256");
      expect(script).toContain("System.Text.UTF8Encoding");
      expect(script).toContain("X509Store");
      expect(script).toContain("exit 1");
      expect(script).not.toContain("NonInteractive");
      expect(fs.readFileSync(path.join(dataDir, "computer-use/excel-addin/setup.json"), "utf8"))
        .not.toContain("test-password");
      expect(excelSetupFailureMessage(Object.assign(new Error("Command failed: powershell.exe"), {
        stderr: "The operation was canceled by the user.\n",
      }))).toBe("Excel add-in setup failed: The operation was canceled by the user.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("dispatches a range read once, accepts only the matching task pane response", async () => {
    const bridge = new ExcelBridge();
    bridge.setConfigured(true);
    const session = randomUUID();
    bridge.heartbeat(session);
    expect(bridge.status()).toMatchObject({ configured: true, connected: true, connectionCount: 1 });
    const pending = bridge.invoke({ kind: "read_range", address: "A1:B2", sheet: "Sheet1" });
    const command = bridge.next(session)!;
    expect(command).toMatchObject({ kind: "read_range", address: "A1:B2", sheet: "Sheet1" });
    expect(bridge.next(session)).toBeNull();
    expect(bridge.complete(randomUUID(), command.id, { ok: true, data: "wrong" })).toBe(false);
    expect(bridge.complete(session, command.id, { ok: true, data: { values: [[1, 2], [3, 4]] } })).toBe(true);
    await expect(pending).resolves.toEqual({ values: [[1, 2], [3, 4]] });
    expect(bridge.complete(session, command.id, { ok: true })).toBe(false);
  });

  it("refuses to guess between workbooks and rejects formulas, invalid ranges, or mismatched writes", async () => {
    const bridge = new ExcelBridge();
    bridge.setConfigured(true);
    bridge.heartbeat(randomUUID());
    bridge.heartbeat(randomUUID());
    expect(bridge.status()).toMatchObject({ connected: false, connectionCount: 2 });
    await expect(bridge.invoke({ kind: "selection" })).rejects.toThrow("More than one Excel workbook");
    expect(() => validateExcelAction({ kind: "write_range", address: "A1", values: [["=HYPERLINK(\"x\")"]] }))
      .toThrow("Formula entry");
    for (const formula of ["+1+1", "-SUM(A1:A2)"]) {
      expect(() => validateExcelAction({ kind: "write_range", address: "A1", values: [[formula]] }))
        .toThrow("Formula entry");
    }
    expect(() => validateExcelAction({ kind: "read_range", address: "A:A" })).toThrow("bounded A1");
    for (const address of ["XFE1", "A1048577", "B2:A1"]) {
      expect(() => validateExcelAction({ kind: "read_range", address })).toThrow("worksheet bounds");
    }
    expect(() => validateExcelAction({ kind: "read_range", address: "A1:J1001" })).toThrow("10,000 cells");
    expect(() => validateExcelAction({ kind: "write_range", address: "A1:B1", values: [[1]] }))
      .toThrow("address dimensions");
    expect(() => validateExcelAction({ kind: "write_range", address: "XFD1048576", values: [["ok"]] }))
      .not.toThrow();
  });

  it("does not replay a dispatched write after a timeout", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new ExcelBridge();
      bridge.setConfigured(true);
      const session = randomUUID();
      bridge.heartbeat(session);
      const pending = bridge.invoke({ kind: "write_range", address: "A1", values: [["test"]] }, 2000);
      const command = bridge.next(session)!;
      const rejected = expect(pending).rejects.toThrow("result is unknown and was not replayed");
      await vi.advanceTimersByTimeAsync(2000);
      await rejected;
      expect(bridge.next(session)).toBeNull();
      expect(bridge.complete(session, command.id, { ok: true })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("produces an Excel-only task pane manifest with localhost HTTPS", () => {
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(excelAddinManifest(32177));
    const app = parsed.OfficeApp;
    expect(app["Version"]).toBe("1.0.0.1");
    expect(app["Hosts"]["Host"]["@_Name"]).toBe("Workbook");
    expect(app["Permissions"]).toBe("ReadWriteDocument");
    expect(app["DefaultSettings"]["SourceLocation"]["@_DefaultValue"]).toBe("https://localhost:32177/taskpane");
    const overrides = app["VersionOverrides"];
    expect(overrides["Hosts"]["Host"]["DesktopFormFactor"]["ExtensionPoint"]["@_xsi:type"])
      .toBe("PrimaryCommandSurface");
    const control = overrides["Hosts"]["Host"]["DesktopFormFactor"]["ExtensionPoint"]["OfficeTab"]["Group"]["Control"];
    expect(control["@_xsi:type"]).toBe("Button");
    expect(control["Action"]["@_xsi:type"]).toBe("ShowTaskpane");
    expect(overrides["Resources"]["bt:Urls"]["bt:Url"]["@_DefaultValue"]).toBe("https://localhost:32177/taskpane");
  });

  it.skipIf(spawnSync("openssl", ["version"]).status !== 0)(
    "serves a protected localhost HTTPS round trip to a simulated Office task pane", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-excel-bridge-"));
      const certPath = path.join(dir, "localhost.crt");
      const keyPath = path.join(dir, "localhost.key");
      const cert = spawnSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
        "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
      ], { stdio: "ignore" });
      expect(cert.status).toBe(0);
      const bridge = new ExcelBridge();
      const server = new ExcelAddinServer(bridge);
      const port = await freePort();
      try {
        await server.start({ certPath, keyPath, port });
        const manifest = await request(port, "/manifest.xml");
        expect(manifest.status).toBe(200);
        expect(manifest.body as string).toContain(`https://localhost:${port}/taskpane`);
        const page = await request(port, "/taskpane");
        expect(page.status).toBe(200);
        const icon = await request(port, "/icon.png", { binary: true });
        expect(icon.status).toBe(200);
        expect((icon.body as Buffer).subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
        expect((icon.body as Buffer).subarray(-8, -4)).toEqual(Buffer.from("49454e44", "hex"));
        const token = (page.body as string).match(/window\.__MEMMY_EXCEL_TOKEN__="([a-f0-9]+)"/)?.[1];
        expect(token).toMatch(/^[a-f0-9]{64}$/);
        expect((await request(port, "/api/next?sessionId=" + randomUUID())).status).toBe(403);
        expect((await request(port, "/api/next?sessionId=" + randomUUID(), {
          token, origin: "https://example.org",
        })).status).toBe(403);
        const sessionId = randomUUID();
        expect((await request(port, "/api/heartbeat", { method: "POST", token, body: { sessionId } })).status).toBe(200);
        expect(bridge.status().connected).toBe(true);
        const pending = bridge.invoke({ kind: "selection" });
        const next = await request(port, `/api/next?sessionId=${sessionId}`, { token });
        const command = JSON.parse(next.body as string).command;
        expect(command.kind).toBe("selection");
        const result = await request(port, "/api/result", {
          method: "POST", token, body: { sessionId, id: command.id, ok: true, data: { address: "A1" } },
        });
        expect(result.status).toBe(200);
        await expect(pending).resolves.toEqual({ address: "A1" });
      } finally {
        await server.stop();
        fs.rmSync(dir, { recursive: true, force: true });
      }
      expect(bridge.status().connected).toBe(false);
    },
  );
});
