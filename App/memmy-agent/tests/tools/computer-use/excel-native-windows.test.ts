import { describe, expect, it, vi } from "vitest";
import {
  nativeWindowsExcelAuthorize, nativeWindowsExcelInvoke, nativeWindowsExcelRunning, nativeWindowsExcelStatus,
  type WindowsExcelRunner,
} from "../../../src/tools/computer-use/excel-native-windows.js";

const id = "windows:2345:QzpcRmluYW5jZS54bHN4";
const connected = {
  available: true, connected: true,
  workbooks: [{ id, name: "Finance.xlsx" }, { id: "windows:2345:Qm9vazE=", name: "Book1" }],
  activeWorkbookId: id,
};
const success = (data: unknown) => JSON.stringify({ ok: true, data });
const decode = (input: string | undefined) => JSON.parse(Buffer.from(input ?? "", "base64").toString("utf8"));
const script = (args: string[]) => Buffer.from(args.at(-1)!, "base64").toString("utf16le");
const result = { workbookId: id, address: "'Sheet1'!A1:B1", rows: 1, columns: 2 };

describe("Windows application-level Excel adapter", () => {
  it("keeps the encoded PowerShell command below the Windows command-line limit", async () => {
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(success({ available: true, connected: false, workbooks: [], activeWorkbookId: null }));
    await nativeWindowsExcelStatus(run);
    const [file, args] = run.mock.calls[0];
    expect([`"${file}"`, ...args].join(" ").length).toBeLessThan(32_767);
  });

  it("explains a busy Excel instead of surfacing a rejected COM call, on any display language", async () => {
    const rejected = (error: string, writeAttempted = false) => vi.fn<WindowsExcelRunner>()
      .mockResolvedValue(JSON.stringify({ ok: false, error, code: "EXCEL_ERROR", writeAttempted }));
    await expect(nativeWindowsExcelStatus(rejected("Call was rejected by callee. (Exception from HRESULT: 0x80010001 (RPC_E_CALL_REJECTED))")))
      .rejects.toThrow("Excel is busy");
    await expect(nativeWindowsExcelInvoke({ kind: "read_range", workbook: id, address: "A1" },
      rejected("应用程序正在使用中。 (异常来自 HRESULT:0x8001010A (RPC_E_SERVERCALL_RETRYLATER))"))).rejects.toThrow("Excel is busy");
    await expect(nativeWindowsExcelInvoke({ kind: "write_range", workbook: id, address: "A1", values: [[1]] },
      rejected("被呼叫方拒绝接收呼叫。 (异常来自 HRESULT:0x80010001 (RPC_E_CALL_REJECTED))", true)))
      .rejects.toThrow(/^Excel is busy.*the result is unknown and was not replayed$/);
    await expect(nativeWindowsExcelStatus(rejected("Multiple Excel application instances are running."))).rejects.toThrow("Multiple Excel");
  });

  it("retries a not-yet-registered Excel only for connection probes", async () => {
    const stopped = { available: true, connected: false, workbooks: [], activeWorkbookId: null };
    const unavailable = JSON.stringify({ ok: false, code: "NOT_CONNECTED",
      error: "The running Excel application is not available for control. HRESULT -2147221021", writeAttempted: false });
    const statusRun = vi.fn<WindowsExcelRunner>().mockResolvedValueOnce(unavailable).mockResolvedValueOnce(success(stopped));
    expect(await nativeWindowsExcelStatus(statusRun)).toEqual(stopped);
    expect(statusRun).toHaveBeenCalledTimes(2);
    const authorizeRun = vi.fn<WindowsExcelRunner>().mockResolvedValueOnce(unavailable).mockResolvedValueOnce(success(stopped));
    expect(await nativeWindowsExcelAuthorize(authorizeRun)).toEqual(stopped);
    expect(authorizeRun).toHaveBeenCalledTimes(2);
    const invokeRun = vi.fn<WindowsExcelRunner>().mockResolvedValue(unavailable);
    await expect(nativeWindowsExcelInvoke({ kind: "write_range", workbook: id, address: "A1", values: [[1]] }, invokeRun))
      .rejects.toThrow("not available for control");
    expect(invokeRun).toHaveBeenCalledOnce();
    const persistentRun = vi.fn<WindowsExcelRunner>().mockResolvedValue(unavailable);
    await expect(nativeWindowsExcelStatus(persistentRun)).rejects.toThrow("HRESULT -2147221021");
    expect(persistentRun).toHaveBeenCalledTimes(4);
  });

  it("checks whether Excel is running without attaching to it", async () => {
    const run = vi.fn<WindowsExcelRunner>()
      .mockResolvedValueOnce('"EXCEL.EXE","2345","Console","1","210,512 K"\r\n')
      .mockResolvedValueOnce("INFO: No tasks are running which match the specified criteria.\r\n")
      .mockRejectedValueOnce(new Error("tasklist failed"));
    expect(await nativeWindowsExcelRunning(run)).toBe(true);
    expect(await nativeWindowsExcelRunning(run)).toBe(false);
    expect(await nativeWindowsExcelRunning(run)).toBe(false);
    expect(run.mock.calls[0][0]).toMatch(/System32[\\/]tasklist\.exe$/i);
    expect(run.mock.calls[0][1]).toEqual(["/FI", "IMAGENAME eq EXCEL.EXE", "/FO", "CSV", "/NH"]);
  });

  it("reports installed Excel without attaching or starting a stopped application", async () => {
    const stopped = { available: true, connected: false, workbooks: [], activeWorkbookId: null };
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(success(stopped));
    expect(await nativeWindowsExcelStatus(run)).toEqual(stopped);
    expect(decode(run.mock.calls[0][2])).toEqual({ operation: "status" });
    const source = script(run.mock.calls[0][1]);
    expect(source).toContain("GetTypeFromProgID('Excel.Application', $false)");
    expect(source).toContain("Get-Process -Name EXCEL");
    expect(source).toContain("if ($request.operation -eq 'authorize')");
    expect(source.indexOf("if ($request.operation -eq 'authorize')")).toBeLessThan(source.indexOf("New-Object -ComObject Excel.Application"));
    expect(source).not.toMatch(/Workbooks\.(Open|Add)|\.Quit\s*\(/);
  });

  it("returns all open workbooks and the active workbook from a single Excel application", async () => {
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(success(connected));
    expect(await nativeWindowsExcelStatus(run)).toEqual(connected);
    expect(run).toHaveBeenCalledOnce();
  });

  it("only launches Excel through the separate explicit authorization operation", async () => {
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(success({ ...connected, connected: false, workbooks: [], activeWorkbookId: null }));
    expect(await nativeWindowsExcelAuthorize(run)).toEqual({ ...connected, connected: false, workbooks: [], activeWorkbookId: null });
    expect(decode(run.mock.calls[0][2])).toEqual({ operation: "authorize" });
    const source = script(run.mock.calls[0][1]);
    expect(source).toContain("$app.Visible = $true");
    expect(source).toContain("$app.UserControl = $true");
    expect(source).toContain("GetActiveObject('Excel.Application')");
    expect(source).toContain("GetBaseException().HResult");
    expect(source).toContain("GetWindowThreadProcessId([IntPtr]$app.Hwnd");
    expect(source).toContain("$instance = [string]$excelProcess");
    expect(source).toContain("ReleaseComObject");
    expect(source).toContain("connected = ($bookInfo.Count -gt 0)");
    expect(source).not.toContain(".Activate(");
  });

  it("checks the input desktop before attaching and again immediately before any write", async () => {
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(success(result));
    await nativeWindowsExcelInvoke({ kind: "write_range", workbook: id, address: "A1:B1", values: [[1, true]] }, run);
    const source = script(run.mock.calls[0][1]);
    expect(source).toContain("OpenInputDesktop(0, $false, 1)");
    expect(source).toContain("GetUserObjectInformation($desktop, 2");
    expect(source).toContain("WTSQuerySessionInformation([IntPtr]::Zero, $session, 8");
    expect(source).toContain("Marshal]::ReadInt32($buffer) -ne 0");
    expect(source).toContain("StringComparison]::OrdinalIgnoreCase");
    expect(source.indexOf("if (-not (Interactive-Desktop))")).toBeLessThan(source.indexOf("GetActiveObject('Excel.Application')"));
    expect(source.lastIndexOf("if (-not (Interactive-Desktop))")).toBeLessThan(source.indexOf("$range.Value2 = $matrix"));
  });

  it("passes quoted cell content and target names only as base64 JSON stdin, with constant executable source", async () => {
    const text = "text '); Start-Process calc; #\n$([IO.File]::Delete('important')) 中文";
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(success(result));
    const action = { kind: "write_range" as const, workbook: id, sheet: "'中文", address: "A1:B1", values: [[text, null]] };
    await nativeWindowsExcelInvoke(action, run);
    await nativeWindowsExcelInvoke({ kind: "selection", workbook: id }, run);
    expect(decode(run.mock.calls[0][2])).toEqual({ operation: "invoke", action });
    expect(run.mock.calls[0][1]).toEqual(run.mock.calls[1][1]);
    expect(run.mock.calls[0][1]).toContain("-EncodedCommand");
    expect(run.mock.calls[0][1].at(-1)!.length).toBeLessThan(30_000);
    expect(run.mock.calls[0][1]).not.toContain(text);
    expect(script(run.mock.calls[0][1])).not.toContain(text);
    expect(script(run.mock.calls[0][1])).toContain("[Console]::In.ReadToEnd()");
    expect(script(run.mock.calls[0][1])).not.toMatch(/Invoke-Expression|ScriptBlock\]::Create/);
  });

  it("preserves the scalar types and rectangular shape of COM Value2 results", async () => {
    const data = { workbookId: id, address: "'Sheet1'!A1:C2", values: [[null, 42.5, true], ["中文", false, ""]] };
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(success(data));
    expect(await nativeWindowsExcelInvoke({ kind: "read_range", workbook: id, address: "A1:C2" }, run)).toEqual(data);
    const source = script(run.mock.calls[0][1]);
    expect(source).toContain("GetLowerBound(0)");
    expect(source).toContain("GetLowerBound(1)");
    expect(source).toContain("CreateInstance([object], [int[]]@($rowCount, $columnCount))");
  });

  it("reports formulas and dates by cell without letting them fail a read", async () => {
    const data = {
      workbookId: id, address: "'Sheet1'!C2:D4", values: [["2026-10-05", 18.5], [46306, 27.5], ["合计", 46]],
      formulas: { 5: "=SUM(D2:D3)" }, dates: { 2: "2026-10-11T00:00:00" },
    };
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(success(data));
    expect(await nativeWindowsExcelInvoke({ kind: "read_range", workbook: id, address: "C2:D4" }, run)).toEqual({
      ...data, formulas: { D4: "=SUM(D2:D3)" }, dates: { C3: "2026-10-11" },
    });
    const source = script(run.mock.calls[0][1]);
    expect(source.indexOf("try {", source.indexOf("$data = @{"))).toBeLessThan(source.indexOf("$range.Formula"));
    expect(source).toContain("$range.Value(10)");
    expect(source).toContain("$v.ToString('s')");
    expect(source.indexOf("} catch { }")).toBeLessThan(source.indexOf("Emit-Result $data"));
    const broken = vi.fn<WindowsExcelRunner>().mockResolvedValue(success({ ...data, formulas: { 6: "=1" } }));
    await expect(nativeWindowsExcelInvoke({ kind: "read_range", workbook: id, address: "C2:D4" }, broken)).rejects.toThrow("invalid range data");
  });

  it("writes formulas, signed text and date text in the same Value2 assignment as other cells", async () => {
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(success({ ...result, address: "'Sheet1'!A1:D1", columns: 4 }));
    const action = { kind: "write_range" as const, workbook: id, address: "A1:D1", values: [["2026-10-11", "'2026-10-11", "=SUM(D3:D8)", "-5"]] };
    await nativeWindowsExcelInvoke(action, run);
    expect(decode(run.mock.calls[0][2])).toEqual({ operation: "invoke", action });
    expect(script(run.mock.calls[0][1])).not.toContain("^[+-]");
  });

  it("names error cells, which COM reports as Int32 error codes", async () => {
    const data = { workbookId: id, address: "'Sheet1'!A1:C1", values: [[{ error: -2146826259 }, 3, { error: -2146826281 }]], formulas: { 0: "=SUMM(B1)", 2: "=B1/0" } };
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(success(data));
    expect(await nativeWindowsExcelInvoke({ kind: "read_range", workbook: id, address: "A1:C1" }, run)).toEqual({
      workbookId: id, address: "'Sheet1'!A1:C1", values: [["#NAME?", 3, "#DIV/0!"]], formulas: { A1: "=SUMM(B1)", C1: "=B1/0" },
    });
    expect(script(run.mock.calls[0][1])).toContain("if ($value -is [int]) { $value = @{ error = $value } }");
    const malformed = vi.fn<WindowsExcelRunner>().mockResolvedValue(success({ ...data, values: [[{ error: "x" }, 3, 4]] }));
    await expect(nativeWindowsExcelInvoke({ kind: "read_range", workbook: id, address: "A1:C1" }, malformed)).rejects.toThrow("invalid range data");
  });

  it("uses the captured ActiveWorkbook only when no exact target was provided", async () => {
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(success(result));
    await nativeWindowsExcelInvoke({ kind: "selection" }, run);
    expect(decode(run.mock.calls[0][2])).toEqual({ operation: "invoke", action: { kind: "selection" } });
    const source = script(run.mock.calls[0][1]);
    expect(source).toContain("$target = $active");
    expect(source).toContain("$id -ceq [string]$request.action.workbook");
    expect(source.indexOf("if ($null -eq $target)")).toBeLessThan(source.indexOf("$range.Value2 = $matrix"));
    expect(source).toContain("$window.RangeSelection");
    expect(source).toContain("if ($areas.Count -ne 1)");
  });

  it.each([
    ["not running", "NOT_CONNECTED", "Excel is not running"],
    ["wrong exact workbook", "WORKBOOK_NOT_FOUND", "The requested Excel workbook is not open"],
    ["locked desktop", "DESKTOP_UNAVAILABLE", "Excel control requires an unlocked interactive Windows desktop"],
    ["multiple application instances", "MULTIPLE_INSTANCES", "Multiple Excel application instances are running"],
  ])("rejects %s without sending another request or replaying a write", async (_case, code, error) => {
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(JSON.stringify({ ok: false, code, error, writeAttempted: false }));
    await expect(nativeWindowsExcelInvoke({ kind: "write_range", workbook: id, address: "A1:B1", values: [[1, true]] }, run))
      .rejects.toThrow(error);
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects a response bound to another workbook", async () => {
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(success({ ...result, workbookId: "windows:2345:Other" }));
    await expect(nativeWindowsExcelInvoke({ kind: "write_range", workbook: id, address: "A1:B1", values: [[1, true]] }, run))
      .rejects.toThrow("different workbook");
    expect(run).toHaveBeenCalledOnce();
  });

  it("validates user actions before dispatch, including oversized ranges and text", async () => {
    const run = vi.fn<WindowsExcelRunner>();
    await expect(nativeWindowsExcelInvoke({ kind: "read_range", address: "A1:Z1000" }, run)).rejects.toThrow("10,000");
    await expect(nativeWindowsExcelInvoke({ kind: "write_range", address: "A1", values: [["x".repeat(32_001)]] }, run)).rejects.toThrow("32,000");
    await expect(nativeWindowsExcelInvoke({ kind: "selection", workbook: "" }, run)).rejects.toThrow("workbook");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects broken response shape and oversized output", async () => {
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValueOnce(success({ ...result, rows: 2 }))
      .mockResolvedValueOnce(success({ workbookId: id, address: "A1:B1", values: [[1]] }))
      .mockResolvedValueOnce("x".repeat(500_001)).mockResolvedValueOnce("not JSON");
    await expect(nativeWindowsExcelInvoke({ kind: "write_range", address: "A1:B1", values: [[1, 2]] }, run)).rejects.toThrow("invalid range data");
    await expect(nativeWindowsExcelInvoke({ kind: "read_range", address: "A1:B1" }, run)).rejects.toThrow("invalid range data");
    await expect(nativeWindowsExcelInvoke({ kind: "selection" }, run)).rejects.toThrow("too large");
    await expect(nativeWindowsExcelInvoke({ kind: "selection" }, run)).rejects.toThrow("invalid response");
  });

  it("keeps timeout and write failure outcomes unknown without replay", async () => {
    const run = vi.fn<WindowsExcelRunner>().mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(JSON.stringify({ ok: false, error: "COM response lost", writeAttempted: true }));
    const action = { kind: "write_range" as const, address: "A1:B1", values: [[1, true]] };
    await expect(nativeWindowsExcelInvoke(action, run)).rejects.toThrow("unknown and was not replayed");
    expect(run).toHaveBeenCalledTimes(1);
    await expect(nativeWindowsExcelInvoke(action, run)).rejects.toThrow("COM response lost; the result is unknown");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects a status claiming that an unlisted workbook is active", async () => {
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(success({ ...connected, activeWorkbookId: "unlisted" }));
    await expect(nativeWindowsExcelStatus(run)).rejects.toThrow("inconsistent connection status");
  });

  it("reports locked or unavailable automation as a status error, not a suggestion to open a workbook", async () => {
    const run = vi.fn<WindowsExcelRunner>().mockResolvedValue(JSON.stringify({ ok: false, error: "Excel control requires an unlocked interactive Windows desktop" }));
    await expect(nativeWindowsExcelStatus(run)).rejects.toThrow("unlocked interactive");
    expect(run).toHaveBeenCalledOnce();
  });
});
