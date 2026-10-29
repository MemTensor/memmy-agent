import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { MAC_EXCEL_SCRIPT, nativeMacExcelAuthorize, nativeMacExcelInvoke, nativeMacExcelRunning, nativeMacExcelStatus } from "../../../src/tools/computer-use/excel-native-mac.js";
import type { NativeExcelRunner } from "../../../src/tools/computer-use/excel-native-runtime.js";

const missingObject = () => Object.assign(new Error("The object you are trying to access does not exist"), { errorNumber: -1728 });
/** Like real Excel, a reference returned by a get fails with -1728 when it is sent back. */
const detached: any = new Proxy({}, { get: () => () => { throw missingObject(); } });
/** A JXA property path: calling it returns a detached reference; its members still resolve. */
function propertyPath(members: Record<string, unknown>): any {
  const path = () => detached;
  for (const [key, value] of Object.entries(members)) Object.defineProperty(path, key, { value });
  return path;
}

/** Execute only against in-memory scripting objects. Never ask the real Excel app. */
function fixture(options: {
  running?: boolean; launchDoesNotStart?: boolean; available?: boolean; permission?: number; authorizePermission?: number; locked?: boolean; session?: Record<string, unknown> | null;
  books?: Array<{ id: string; name: string; sheet?: string; values?: unknown; formulas?: unknown; typed?: unknown }>;
  active?: number | null; selection?: string; areas?: number;
  clearError?: boolean; lockAfterWrite?: boolean;
} = {}) {
  const calls: Array<{ kind: string; book?: string; sheet?: string; address?: string; value?: unknown; ask?: boolean }> = [];
  let running = options.running ?? true;
  let permission = options.permission ?? 0;
  const sheetForBook = new Map<any, any>();
  const books = (options.books ?? [
    { id: "/Users/test/A.xlsx", name: "A.xlsx", sheet: "Data", values: [[1, true], ["文字", null]] },
    { id: "/Users/test/B.xlsx", name: "B.xlsx", sheet: "Other", values: [[99]] },
  ]).map(item => {
    const book: any = { name: () => item.name, fullName: () => item.id };
    const sheet: any = { name: () => item.sheet ?? "Sheet1" };
    const ranges = new Map<string, any>();
    sheet.ranges = { byName: (address: string) => {
      if (!ranges.has(address)) {
        const range: any = { address, sheet, book, areas: () => Array.from({ length: options.areas ?? 1 }, () => range), worksheetObject: () => sheet };
        Object.defineProperty(range, "value2", {
          get: () => () => { calls.push({ kind: "read", book: item.id, sheet: sheet.name(), address }); return item.values ?? [[null]]; },
          set: value => { calls.push({ kind: "write", book: item.id, sheet: sheet.name(), address, value }); },
        });
        // Without fixture data these reads fail, as an unexpected Excel reply would.
        if (item.formulas !== undefined) range.formula = () => item.formulas;
        if (item.typed !== undefined) range.value = () => item.typed;
        ranges.set(address, range);
      }
      return ranges.get(address);
    } };
    book.worksheets = { byName: (name: string) => name === sheet.name() ? sheet : detached };
    book.activeSheet = propertyPath({ name: () => sheet.name() });
    sheetForBook.set(book, sheet);
    return book;
  });
  const workbooks: any = {
    at: (index: number) => books[index],
    byName: (name: string) => {
      calls.push({ kind: "target", book: name });
      return books.find(candidate => candidate.name() === name) ?? detached;
    },
  };
  Object.defineProperty(workbooks, "length", { get: () => { calls.push({ kind: "enumerate" }); return books.length; } });
  const activeBook = () => {
    const book = options.active === null ? undefined : books[options.active ?? 0];
    if (!book) throw missingObject();
    return book;
  };
  const selected = () => sheetForBook.get(activeBook()).ranges.byName(options.selection ?? "$A$1:$B$2");
  const selection = propertyPath({
    areas: () => selected().areas(),
    worksheetObject: propertyPath({ name: () => selected().worksheetObject().name() }),
  });
  Object.defineProperty(selection, "address", { get: () => selected().address });
  const excel = {
    running: () => running,
    launch: () => { calls.push({ kind: "launch" }); running = !options.launchDoesNotStart; },
    name: () => { calls.push({ kind: "name" }); return "Microsoft Excel"; },
    workbooks,
    activeWorkbook: propertyPath({ name: () => activeBook().name(), fullName: () => activeBook().fullName() }),
    selection,
    getAddress: (range: any) => range.address,
    clearContents: (range: any) => {
      calls.push({ kind: "clear", book: range.book.fullName(), sheet: range.sheet.name(), address: range.address });
      if (options.clearError) throw new Error("Excel rejected clearing cells");
    },
  };
  const run: NativeExcelRunner = vi.fn(async (file, args, input) => {
    expect(file).toBe("/usr/bin/osascript");
    expect(args).toEqual(["-l", "JavaScript", "-e", MAC_EXCEL_SCRIPT]);
    const context = {
      Application: () => excel,
      ObjC: { import: () => undefined, bindFunction: () => undefined, unwrap: (value: any) => value, deepUnwrap: (value: any) => value },
      $: {
        NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: input } },
        NSString: { alloc: { initWithDataEncoding: (value: any) => value } },
        NSUTF8StringEncoding: 4,
        NSWorkspace: { sharedWorkspace: { URLForApplicationWithBundleIdentifier: () => ({ path: options.available === false ? null : "/Applications/Microsoft Excel.app" }) } },
        NSAppleEventDescriptor: { descriptorWithBundleIdentifier: () => ({ aeDesc: {} }) },
        CGSessionCopyCurrentDictionary: () => options.session !== undefined ? options.session : { kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true, ...(options.locked || options.lockAfterWrite && calls.some(call => call.kind === "write") ? { CGSSessionScreenIsLocked: true } : {}) },
        AEDeterminePermissionToAutomateTarget: (_target: unknown, _eventClass: number, _eventId: number, ask: boolean) => {
          expect(_eventClass).toBe(0x2a2a2a2a);
          expect(_eventId).toBe(0x2a2a2a2a);
          calls.push({ kind: "permission", ask });
          if (ask && options.authorizePermission !== undefined) permission = options.authorizePermission;
          return permission;
        },
      },
    };
    return new Script(MAC_EXCEL_SCRIPT + "\nrun();").runInNewContext(context);
  });
  return { run, calls };
}

describe("Mac application-wide Excel control", () => {
  it("enumerates both saved and unsaved workbooks without starting or activating Excel", async () => {
    const { run, calls } = fixture({ books: [{ id: "/Users/test/A.xlsx", name: "A.xlsx" }, { id: "工作簿1", name: "工作簿1" }], active: 1 });
    expect(await nativeMacExcelStatus(run)).toEqual({ available: true, connected: true, workbooks: [{ id: "/Users/test/A.xlsx", name: "A.xlsx" }, { id: "工作簿1", name: "工作簿1" }], activeWorkbookId: "工作簿1" });
    expect(calls.some(call => call.kind === "launch" || call.kind === "name" || call.ask)).toBe(false);
  });

  it("never launches Excel from status when it is stopped, or opens a file to connect", async () => {
    const { run, calls } = fixture({ running: false });
    expect(await nativeMacExcelStatus(run)).toEqual({ available: true, connected: false, workbooks: [], activeWorkbookId: null });
    expect(calls).toEqual([]);
    await expect(nativeMacExcelInvoke({ kind: "read_range", address: "A1" }, run)).rejects.toThrow("not running");
    expect(calls).toEqual([]);
  });

  it("checks whether Excel is running through LaunchServices, outside the control script", async () => {
    const run = vi.fn<NativeExcelRunner>().mockResolvedValueOnce("true\n").mockResolvedValueOnce("false")
      .mockRejectedValueOnce(new Error("Application can't be found. (-2700)"));
    expect(await nativeMacExcelRunning(run)).toBe(true);
    expect(await nativeMacExcelRunning(run)).toBe(false);
    expect(await nativeMacExcelRunning(run)).toBe(false);
    expect(run).toHaveBeenCalledWith("/usr/bin/osascript", ["-l", "JavaScript", "-e", 'Application("com.microsoft.Excel").running()']);
    expect(run.mock.calls.some(call => call[1].includes(MAC_EXCEL_SCRIPT))).toBe(false);
  });

  it("reports Excel not installed without attempting an event", async () => {
    const { run, calls } = fixture({ available: false });
    expect(await nativeMacExcelStatus(run)).toEqual({ available: false, connected: false, workbooks: [], activeWorkbookId: null });
    await expect(nativeMacExcelAuthorize(run)).rejects.toThrow("not installed");
    expect(calls).toEqual([]);
  });

  it("explicitly requests full Automation permission after launching Excel without opening a workbook", async () => {
    const { run, calls } = fixture({ running: false, books: [] });
    expect(await nativeMacExcelAuthorize(run)).toEqual({ available: true, connected: false, workbooks: [], activeWorkbookId: null });
    expect(calls).toEqual([{ kind: "launch" }, { kind: "permission", ask: true }, { kind: "enumerate" }]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("authorizes while an unsaved workbook is open, although Excel cannot resolve the references it returns", async () => {
    const { run } = fixture({ books: [{ id: "工作簿1", name: "工作簿1" }] });
    expect(await nativeMacExcelAuthorize(run)).toEqual({ available: true, connected: true, workbooks: [{ id: "工作簿1", name: "工作簿1" }], activeWorkbookId: "工作簿1" });
  });

  it("lists a hidden workbook that has no active window and asks for a workbook ID instead of guessing", async () => {
    const { run, calls } = fixture({ books: [{ id: "PERSONAL.XLSB", name: "PERSONAL.XLSB" }], active: null });
    expect(await nativeMacExcelStatus(run)).toEqual({ available: true, connected: true, workbooks: [{ id: "PERSONAL.XLSB", name: "PERSONAL.XLSB" }], activeWorkbookId: null });
    await expect(nativeMacExcelInvoke({ kind: "read_range", address: "A1" }, run)).rejects.toMatchObject({ code: "workbookMissing", message: expect.stringContaining("No Excel workbook is active") });
    expect(calls.some(call => call.kind === "read")).toBe(false);
  });

  it.each([
    [-1743, "Automation denied"],
    [-1744, "Automation permission required"],
  ] as const)("checks Automation without a prompt before status or controls (%s)", async (permission, message) => {
    const { run, calls } = fixture({ permission });
    await expect(nativeMacExcelStatus(run)).rejects.toMatchObject({ code: permission, message: expect.stringContaining(message), resultUnknown: false });
    await expect(nativeMacExcelInvoke({ kind: "write_range", address: "A1", values: [[1]] }, run)).rejects.toMatchObject({ code: permission, message: expect.stringContaining(message), resultUnknown: false });
    expect(calls).toEqual([{ kind: "permission", ask: false }, { kind: "permission", ask: false }]);
  });

  it("recovers a pending first grant through explicit authorization, then checks it silently", async () => {
    const { run, calls } = fixture({ permission: -1744, authorizePermission: 0 });
    await expect(nativeMacExcelStatus(run)).rejects.toMatchObject({ code: -1744 });
    expect((await nativeMacExcelAuthorize(run)).connected).toBe(true);
    expect((await nativeMacExcelStatus(run)).connected).toBe(true);
    expect(calls.filter(call => call.kind === "permission")).toEqual([
      { kind: "permission", ask: false }, { kind: "permission", ask: true }, { kind: "permission", ask: false },
    ]);
    expect(calls.some(call => call.kind === "name" || call.kind === "write")).toBe(false);
  });

  it("does not claim authorization succeeded when Excel failed to start", async () => {
    const { run, calls } = fixture({ running: false, launchDoesNotStart: true });
    await expect(nativeMacExcelAuthorize(run)).rejects.toMatchObject({ code: "excelNotRunning", message: expect.stringContaining("retry authorization") });
    expect(calls).toEqual([{ kind: "launch" }]);
  });

  it("stops authorization before enumerating workbooks when the system grant is denied", async () => {
    const { run, calls } = fixture({ permission: -1744, authorizePermission: -1743 });
    await expect(nativeMacExcelAuthorize(run)).rejects.toMatchObject({ code: -1743, message: expect.stringContaining("System Settings"), resultUnknown: false });
    expect(calls).toEqual([{ kind: "permission", ask: true }]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { kCGSSessionOnConsoleKey: false, kCGSessionLoginDoneKey: true }, { kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: false }])("fails closed for unknown or inactive login sessions", async session => {
    const { run, calls } = fixture({ session });
    await expect(nativeMacExcelInvoke({ kind: "read_range", address: "A1" }, run)).rejects.toThrow("could not be verified");
    expect(calls).toEqual([]);
  });

  it("blocks a locked session before authorization, launch or a write", async () => {
    const { run, calls } = fixture({ locked: true, running: false });
    await expect(nativeMacExcelAuthorize(run)).rejects.toThrow("macOS is locked");
    await expect(nativeMacExcelInvoke({ kind: "write_range", address: "A1", values: [[1]] }, run)).rejects.toThrow("macOS is locked");
    expect(calls).toEqual([]);
  });

  it("reads a concrete background workbook without enumerating or activating other workbooks", async () => {
    const { run, calls } = fixture();
    expect(await nativeMacExcelInvoke({ kind: "read_range", workbook: "/Users/test/B.xlsx", sheet: "Other", address: "A1" }, run)).toEqual({ workbookId: "/Users/test/B.xlsx", address: "'Other'!A1", values: [[99]] });
    expect(calls.filter(call => call.kind === "read")).toEqual([{ kind: "read", book: "/Users/test/B.xlsx", sheet: "Other", address: "A1" }]);
    expect(calls.some(call => call.kind === "enumerate" || call.kind === "launch")).toBe(false);
  });

  it("matches the full workbook identity rather than accepting a basename collision", async () => {
    const { run, calls } = fixture();
    await expect(nativeMacExcelInvoke({ kind: "write_range", workbook: "/Different/Folder/A.xlsx", address: "A1", values: [[1]] }, run)).rejects.toThrow("requested Excel workbook is not open");
    expect(calls.some(call => call.kind === "write")).toBe(false);
  });

  it("names a missing workbook or worksheet instead of Excel's generic missing object", async () => {
    const { run, calls } = fixture();
    await expect(nativeMacExcelInvoke({ kind: "read_range", workbook: "/Users/test/Closed.xlsx", address: "A1" }, run)).rejects.toMatchObject({ code: "workbookMissing", message: "The requested Excel workbook is not open" });
    await expect(nativeMacExcelInvoke({ kind: "write_range", workbook: "/Users/test/A.xlsx", sheet: "Missing", address: "A1", values: [[1]] }, run)).rejects.toMatchObject({ code: "sheetMissing", message: "The requested Excel worksheet does not exist", resultUnknown: false });
    expect(calls.some(call => call.kind === "read" || call.kind === "write")).toBe(false);
  });

  it("returns the active workbook selection and refuses multi-area or another workbook's selection", async () => {
    const { run } = fixture();
    expect(await nativeMacExcelInvoke({ kind: "selection" }, run)).toEqual({ workbookId: "/Users/test/A.xlsx", address: "'Data'!$A$1:$B$2", rows: 2, columns: 2 });
    await expect(nativeMacExcelInvoke({ kind: "selection" }, fixture({ areas: 2 }).run)).rejects.toThrow("multiple areas");
    await expect(nativeMacExcelInvoke({ kind: "selection", workbook: "/Users/test/B.xlsx" }, run)).rejects.toThrow("only in the active workbook");
    await expect(nativeMacExcelInvoke({ kind: "selection" }, fixture({ selection: "$A$1:$XFD$1048576" }).run)).rejects.toThrow("10,000 cells");
  });

  it("sends strings only as JSON data, preserves scalar types and clears null cells", async () => {
    const malicious = '"; Application("Finder").activate(); // $() `word` 中文';
    const { run, calls } = fixture();
    await nativeMacExcelInvoke({ kind: "write_range", address: "A1:B2", values: [[malicious, false], [0, null]] }, run);
    expect(calls.filter(call => call.kind === "write")).toEqual([{ kind: "write", book: "/Users/test/A.xlsx", sheet: "Data", address: "A1:B2", value: [[malicious, false], [0, ""]] }]);
    expect(calls.filter(call => call.kind === "clear")).toEqual([{ kind: "clear", book: "/Users/test/A.xlsx", sheet: "Data", address: "B2" }]);
    expect((run as any).mock.calls[0][1][3]).not.toContain(malicious);
    expect(JSON.parse((run as any).mock.calls[0][2]).action.values[0][0]).toBe(malicious);
  });

  it("rejects oversized requests before dispatch and oversized results without replaying", async () => {
    const run = vi.fn(async () => "");
    const values = Array.from({ length: 20 }, () => ["界".repeat(10_000)]);
    await expect(nativeMacExcelInvoke({ kind: "write_range", address: "A1:A20", values }, run)).rejects.toThrow("500,000 bytes");
    expect(run).not.toHaveBeenCalled();
    const largeResult = fixture({ books: [{ id: "Book1", name: "Book1", values: [["x".repeat(500_000)]] }] });
    await expect(nativeMacExcelInvoke({ kind: "read_range", address: "A1" }, largeResult.run)).rejects.toThrow("500,000 bytes");
    expect(largeResult.run).toHaveBeenCalledTimes(1);
  });

  it("uses shared action validation before native dispatch", async () => {
    const run = vi.fn(async () => "");
    await expect(nativeMacExcelInvoke({ kind: "read_range", address: "A1:Z1000" }, run)).rejects.toThrow("10,000 cells");
    expect(run).not.toHaveBeenCalled();
  });

  it("enters formulas and date text through the same value2 write Excel uses for typing", async () => {
    const { run, calls } = fixture();
    await nativeMacExcelInvoke({ kind: "write_range", workbook: "/Users/test/A.xlsx", address: "A9:D9", values: [["2026-10-11", "'2026-10-11", "合计", "=SUM(D3:D8)"]] }, run);
    expect(calls.filter(call => call.kind === "write")).toEqual([{ kind: "write", book: "/Users/test/A.xlsx", sheet: "Data", address: "A9:D9", value: [["2026-10-11", "'2026-10-11", "合计", "=SUM(D3:D8)"]] }]);
  });

  it("reports formulas and dates by cell, since value2 shows only results and serial numbers", async () => {
    const { run } = fixture({ books: [{
      id: "/Users/test/A.xlsx", name: "A.xlsx", sheet: "Data",
      values: [["2026-10-05", 18.5], [46306, 27.5], ["合计", 46]],
      formulas: [["2026-10-05", "18.5"], ["10/11/2026", "27.5"], ["合计", "=SUM(B1:B2)"]],
      typed: [["2026-10-05", 18.5], [new Date(2026, 9, 11), 27.5], ["合计", 46]],
    }] });
    expect(await nativeMacExcelInvoke({ kind: "read_range", workbook: "/Users/test/A.xlsx", address: "C2:D4" }, run)).toEqual({
      workbookId: "/Users/test/A.xlsx", address: "'Data'!C2:D4",
      values: [["2026-10-05", 18.5], [46306, 27.5], ["合计", 46]],
      formulas: { D4: "=SUM(B1:B2)" }, dates: { C3: "2026-10-11" },
    });
  });

  it("keeps a read when Excel cannot report formulas, or omits them when the result would be too large", async () => {
    const plain = fixture({ books: [{ id: "Book1", name: "Book1", values: [[1, 2]], typed: [[1, 2]] }] });
    expect(await nativeMacExcelInvoke({ kind: "read_range", address: "A1:B1", workbook: "Book1" }, plain.run)).toEqual({ workbookId: "Book1", address: "'Sheet1'!A1:B1", values: [[1, 2]] });
    const text = "x".repeat(30_000);
    const values = Array.from({ length: 10 }, () => [text]);
    const formulas = Array.from({ length: 10 }, () => [`="${"y".repeat(29_990)}"`]);
    const large = fixture({ books: [{ id: "Book1", name: "Book1", values, formulas, typed: values }] });
    expect(await nativeMacExcelInvoke({ kind: "read_range", address: "A1:A10", workbook: "Book1" }, large.run)).toEqual({
      workbookId: "Book1", address: "'Sheet1'!A1:A10", values, note: expect.stringContaining("read a smaller range"),
    });
  });

  it("does not retry a timed-out write and labels native Automation denial", async () => {
    const timeout = vi.fn(async () => { throw new Error("Excel operation timed out; result may be unknown and was not replayed"); });
    await expect(nativeMacExcelInvoke({ kind: "write_range", address: "A1", values: [[1]] }, timeout)).rejects.toThrow("unknown");
    expect(timeout).toHaveBeenCalledTimes(1);
    const denied = vi.fn(async () => { throw new Error("Not authorized to send Apple events to Microsoft Excel. (-1743)"); });
    await expect(nativeMacExcelStatus(denied)).rejects.toMatchObject({ code: -1743, message: expect.stringContaining("Automation denied (-1743)") });
    const pending = vi.fn(async () => { throw new Error("Apple event would require user consent. (-1744)"); });
    await expect(nativeMacExcelAuthorize(pending)).rejects.toMatchObject({ code: -1744, message: expect.stringContaining("Automation permission required (-1744)") });
    expect(pending).toHaveBeenCalledTimes(1);
    await expect(nativeMacExcelInvoke({ kind: "write_range", address: "A1", values: [[1]] }, pending)).rejects.toMatchObject({ code: -1744, resultUnknown: true, message: expect.stringContaining("not replayed") });
  });

  it.each([{ clearError: true }, { lockAfterWrite: true }])("reports an uncertain result when clearing nulls fails or the session locks after writing", async options => {
    const { run, calls } = fixture(options);
    await expect(nativeMacExcelInvoke({ kind: "write_range", address: "A1:B1", values: [[null, 1]] }, run)).rejects.toMatchObject({ resultUnknown: true, message: expect.stringContaining("result is unknown and was not replayed") });
    expect(calls.filter(call => call.kind === "write")).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    "not JSON",
    JSON.stringify({ protocol: "wrong", ok: true }),
    "x".repeat(500_001),
    JSON.stringify({ protocol: "memmy.excel.mac.v1", ok: true, data: { address: "'Data'!A1", rows: 1, columns: 1 } }),
    JSON.stringify({ protocol: "memmy.excel.mac.v1", ok: true, data: { workbookId: "wrong", address: "'Data'!A1", rows: 1, columns: 1 } }),
    JSON.stringify({ protocol: "memmy.excel.mac.v1", ok: true, data: { workbookId: "A", address: "'Data'!A1", rows: 2, columns: 1 } }),
  ])("never treats an invalid write response as an ordinary retryable error", async output => {
    const run = vi.fn(async () => output);
    await expect(nativeMacExcelInvoke({ kind: "write_range", workbook: "A", address: "A1", values: [[1]] }, run)).rejects.toMatchObject({ resultUnknown: true, message: expect.stringContaining("result is unknown and was not replayed") });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    { available: true, connected: true, workbooks: [{ id: "A", name: "A" }, { id: "A", name: "Duplicate" }], activeWorkbookId: "A" },
    { available: true, connected: true, workbooks: [{ id: "A", name: "A" }], activeWorkbookId: "B" },
    { available: true, connected: true, workbooks: [], activeWorkbookId: null },
    { available: false, connected: false, workbooks: [{ id: "A", name: "A" }], activeWorkbookId: "A" },
  ])("rejects inconsistent workbook status", async data => {
    await expect(nativeMacExcelStatus(async () => JSON.stringify({ protocol: "memmy.excel.mac.v1", ok: true, data }))).rejects.toThrow("invalid workbook status");
  });

  it("rejects malformed native envelopes or mismatched result workbook IDs", async () => {
    await expect(nativeMacExcelStatus(async () => "not JSON")).rejects.toThrow("invalid native response");
    await expect(nativeMacExcelStatus(async () => JSON.stringify({ protocol: "memmy.excel.mac.v1", ok: true, data: {} }))).rejects.toThrow("invalid workbook status");
    await expect(nativeMacExcelInvoke({ kind: "read_range", workbook: "A", address: "A1" }, async () => JSON.stringify({ protocol: "memmy.excel.mac.v1", ok: true, data: { workbookId: "B" } }))).rejects.toThrow("different workbook");
  });

  (process.platform === "darwin" ? it : it.skip)("compiles the fixed JXA script without executing Excel or changing permissions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-excel-jxa-"));
    try {
      execFileSync("/usr/bin/osacompile", ["-l", "JavaScript", "-o", path.join(directory, "excel.scpt")], { input: MAC_EXCEL_SCRIPT, encoding: "utf8", timeout: 10_000 });
      expect(fs.statSync(path.join(directory, "excel.scpt")).size).toBeGreaterThan(0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
