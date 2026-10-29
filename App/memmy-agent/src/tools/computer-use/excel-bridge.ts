// Office.js task panes connect to this in-process bridge over localhost HTTPS.
// A command is dispatched once and never replayed after a timeout.
import { randomUUID } from "node:crypto";

export type ExcelBridgeAction = (
  | { kind: "selection" }
  | { kind: "read_range"; address: string; sheet?: string }
  | { kind: "write_range"; address: string; sheet?: string; values: Array<Array<string | number | boolean | null>> }
) & { workbook?: string };

export type ExcelBridgeCommand = ExcelBridgeAction & { id: string };
export type ExcelBridgeStatus = {
  connected: boolean;
  connectionCount: number;
  configured: boolean;
};

type Session = { id: string; seenAt: number };
type Pending = {
  sessionId: string;
  command: ExcelBridgeCommand;
  dispatched: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

const SESSION_TTL_MS = 10_000;
const COMMAND_TIMEOUT_MS = 15_000;
const SESSION_RE = /^[a-f0-9-]{20,80}$/i;
const A1_RE = /^(\$?)([A-Z]{1,3})(\$?)([1-9][0-9]{0,6})(?::(\$?)([A-Z]{1,3})(\$?)([1-9][0-9]{0,6}))?$/i;

function a1Column(value: string): number {
  return [...value.toUpperCase()].reduce((column, char) => column * 26 + char.charCodeAt(0) - 64, 0);
}

function a1Dimensions(address: string): { rows: number; columns: number; firstColumn: number; firstRow: number } {
  if (typeof address !== "string" || address.length > 32) throw new Error("Excel range must be a bounded A1 address");
  const match = A1_RE.exec(address);
  if (!match) throw new Error("Excel range must be a bounded A1 address");
  const firstColumn = a1Column(match[2]);
  const firstRow = Number(match[4]);
  const lastColumn = match[6] ? a1Column(match[6]) : firstColumn;
  const lastRow = match[8] ? Number(match[8]) : firstRow;
  if (firstColumn > 16_384 || lastColumn > 16_384 || firstRow > 1_048_576 || lastRow > 1_048_576
    || lastColumn < firstColumn || lastRow < firstRow) {
    throw new Error("Excel range is outside the worksheet bounds");
  }
  const rows = lastRow - firstRow + 1;
  const columns = lastColumn - firstColumn + 1;
  if (rows * columns > 10_000) throw new Error("Excel range exceeds 10,000 cells");
  return { rows, columns, firstColumn, firstRow };
}

function a1Cell(column: number, row: number): string {
  let name = "";
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) name = String.fromCharCode(65 + (rest - 1) % 26) + name;
  return `${name}${row}`;
}

// COM reports an error cell as the HRESULT 0x800A0000 plus its XlCVError number.
const EXCEL_ERRORS: Record<number, string> = {
  2000: "#NULL!", 2007: "#DIV/0!", 2015: "#VALUE!", 2023: "#REF!", 2029: "#NAME?", 2036: "#NUM!", 2042: "#N/A",
  2043: "#GETTING_DATA", 2045: "#SPILL!", 2046: "#CONNECT!", 2047: "#BLOCKED!", 2048: "#UNKNOWN!", 2049: "#FIELD!", 2050: "#CALC!",
};

export function excelErrorText(code: number): string {
  return EXCEL_ERRORS[code + 2_146_828_288] ?? "#ERROR!";
}

export type ExcelReadDetails = { formulas?: Record<string, string>; dates?: Record<string, string>; note?: string };
const NATIVE_DATE_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})$/;

/** Native scripts key formulas and dates by row-major cell index; report them by A1 cell. */
export function excelReadDetails(native: { formulas?: unknown; dates?: unknown; note?: unknown }, address: string): ExcelReadDetails {
  const { rows, columns, firstColumn, firstRow } = a1Dimensions(address);
  const cells = (map: unknown, read: (text: string) => string | null): Record<string, string> | undefined => {
    if (map === undefined || map === null) return undefined;
    if (typeof map !== "object" || Array.isArray(map)) throw new Error("Excel returned invalid cell details");
    const result: Record<string, string> = {};
    for (const [key, text] of Object.entries(map)) {
      const value = typeof text === "string" ? read(text) : null;
      if (!/^\d{1,5}$/.test(key) || Number(key) >= rows * columns || value === null) throw new Error("Excel returned invalid cell details");
      result[a1Cell(firstColumn + Number(key) % columns, firstRow + Math.floor(Number(key) / columns))] = value;
    }
    return Object.keys(result).length ? result : undefined;
  };
  const formulas = cells(native.formulas, text => text.startsWith("=") && text.length <= 32_000 ? text : null);
  const dates = cells(native.dates, text => {
    const match = NATIVE_DATE_RE.exec(text);
    if (!match) return null;
    // A time without a date is Excel's day zero.
    if (match[1] === "1899-12-30") return match[2];
    return match[2] === "00:00:00" ? match[1] : `${match[1]} ${match[2]}`;
  });
  const note = typeof native.note === "string" && native.note ? native.note.slice(0, 200) : undefined;
  return { ...(formulas ? { formulas } : {}), ...(dates ? { dates } : {}), ...(note ? { note } : {}) };
}

export function validateExcelAction(action: ExcelBridgeAction): void {
  if (action.workbook !== undefined && (typeof action.workbook !== "string" || !action.workbook.trim()
    || action.workbook.length > 4096 || /[\u0000-\u001f]/.test(action.workbook))) {
    throw new Error("Invalid Excel workbook identity");
  }
  if (action.kind === "selection") return;
  const dimensions = a1Dimensions(action.address);
  if (action.sheet !== undefined && (!action.sheet || action.sheet.length > 31
    || ["[", "]", ":", "*", "?", "/", "\\"].some(char => action.sheet!.includes(char)))) {
    throw new Error("Invalid Excel sheet name");
  }
  if (action.kind === "read_range") return;
  if (action.kind !== "write_range" || !Array.isArray(action.values) || !action.values.length || action.values.length > 1000) {
    throw new Error("Invalid Excel write values");
  }
  const width = action.values[0]?.length;
  if (!width || width > 100 || width * action.values.length > 10_000) throw new Error("Excel write exceeds 10,000 cells");
  if (dimensions.rows !== action.values.length || dimensions.columns !== width) {
    throw new Error("Excel write values must match the address dimensions");
  }
  for (const row of action.values) {
    if (!Array.isArray(row) || row.length !== width) throw new Error("Excel write values must be rectangular");
    for (const value of row) {
      if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error("Excel write values must be scalar");
      }
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Excel write values must be finite");
      if (typeof value === "string" && value.length > 32_000) throw new Error("Excel cell text is limited to 32,000 characters");
    }
  }
}

export class ExcelBridge {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Pending>();
  private configured = false;
  constructor(private readonly now: () => number = Date.now) {}

  setConfigured(configured: boolean): void {
    this.configured = configured;
    if (!configured) this.close();
  }

  private liveSessions(): Session[] {
    const cutoff = this.now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions) if (session.seenAt < cutoff) this.sessions.delete(id);
    return [...this.sessions.values()];
  }

  status(): ExcelBridgeStatus {
    const count = this.liveSessions().length;
    return { connected: this.configured && count === 1, connectionCount: count, configured: this.configured };
  }

  heartbeat(sessionId: string): void {
    if (!this.configured || !SESSION_RE.test(sessionId)) throw new Error("Invalid Excel add-in session");
    this.sessions.set(sessionId, { id: sessionId, seenAt: this.now() });
  }

  next(sessionId: string): ExcelBridgeCommand | null {
    this.heartbeat(sessionId);
    if (this.liveSessions().length !== 1) return null;
    const pending = [...this.pending.values()].find(item => item.sessionId === sessionId && !item.dispatched);
    if (!pending) return null;
    // Mark before returning. Lost responses are uncertain and never replayed.
    pending.dispatched = true;
    return pending.command;
  }

  complete(sessionId: string, id: string, result: { ok: boolean; data?: unknown; error?: string }): boolean {
    this.heartbeat(sessionId);
    const pending = this.pending.get(id);
    if (!pending || !pending.dispatched || pending.sessionId !== sessionId) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (result.ok) pending.resolve(result.data);
    else pending.reject(new Error((result.error ?? "Excel add-in action failed").slice(0, 500)));
    return true;
  }

  async invoke(action: ExcelBridgeAction, timeoutMs = COMMAND_TIMEOUT_MS): Promise<unknown> {
    validateExcelAction(action);
    const sessions = this.liveSessions();
    if (!this.configured || sessions.length !== 1) throw new Error(
      sessions.length > 1
        ? "More than one Excel workbook is connected. Ask the user to close the extra Memmy pane and keep open only the workbook they want changed."
        : "Excel is not connected. Ask the user to turn on Microsoft Excel in Computer Use. On Mac, use the dialog that opens Full Disk Access. Then reopen Excel, open the workbook, choose Insert, click Memmy, and leave that pane open. Do not say add-in.",
    );
    const command = { ...action, id: randomUUID() } as ExcelBridgeCommand;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error("Excel add-in did not acknowledge the action; result is unknown and was not replayed"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(command.id, { sessionId: sessions[0].id, command, dispatched: false, resolve, reject, timer });
    });
  }

  close(): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Excel bridge stopped; dispatched action result is unknown"));
    }
    this.pending.clear();
    this.sessions.clear();
  }
}

export const excelBridge = new ExcelBridge();
