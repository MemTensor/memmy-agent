import path from "node:path";
import { excelErrorText, excelReadDetails, validateExcelAction, type ExcelBridgeAction, type ExcelReadDetails } from "./excel-bridge.js";
import { nativeExcelRunner, runNativeExcelCommand, type NativeExcelRunner, type NativeExcelStatus } from "./excel-native-runtime.js";

export type WindowsExcelRunner = NativeExcelRunner;
export type NativeWindowsExcelStatus = NativeExcelStatus;
type NativeAction = ExcelBridgeAction;
type Operation = "status" | "invoke" | "authorize";
const MAX_RESULT_BYTES = 500_000;
// Excel rejects COM calls while a cell is being edited or a dialog is open. The
// HRESULT stays in the exception text on every Windows display language.
const EXCEL_BUSY_HRESULT = /0x80010001|0x8001010A|RPC_E_CALL_REJECTED|RPC_E_SERVERCALL_RETRYLATER/i;
const EXCEL_BUSY = "Excel is busy because a cell is being edited or a dialog is open. Ask the user to press Enter or close the dialog in Excel, then try again.";
const NO_CONNECTION: NativeWindowsExcelStatus = {
  available: false, connected: false, workbooks: [], activeWorkbookId: null,
};

/** This script is constant. The request is base64 JSON read from stdin, never executable text.
 * GetActiveObject attaches only to an existing Excel Application. Only the explicit
 * authorize operation may create an Application; it never adds or opens a workbook.
 * https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.marshal.getactiveobject
 * https://learn.microsoft.com/en-us/office/vba/api/excel.application.activeworkbook
 * https://learn.microsoft.com/en-us/office/vba/api/excel.range.value2
 */
const WINDOWS_EXCEL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$refs = New-Object 'System.Collections.Generic.List[object]'
$writeAttempted = $false
$failureCode = 'EXCEL_ERROR'

function Track-Com($value) {
  if ($null -ne $value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) {
    $refs.Add($value)
  }
}
function Workbook-Id($book, $instance) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$book.FullName))
  return 'windows:' + $instance + ':' + $encoded
}
function Cell-At($a, $r, $c) {
  if ($a -isnot [Array]) { return $a }
  if ($a.Rank -ne 2) { throw 'Excel returned an unsupported cell array' }
  return $a.GetValue($r + $a.GetLowerBound(0), $c + $a.GetLowerBound(1))
}
function Emit-Result($data) {
  $json = ConvertTo-Json -InputObject @{ ok = $true; data = $data } -Depth 20 -Compress
  if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 500000) {
    $script:failureCode = 'RESULT_TOO_LARGE'
    throw 'Excel range result is too large'
  }
  [Console]::Out.WriteLine($json)
}
function Interactive-Desktop {
  if (-not ('MemmyExcelDesktop' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MemmyExcelDesktop {
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr handle);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQuerySessionInformation(IntPtr server, int session, int information, out IntPtr buffer, out uint bytes);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr buffer);
}
'@
  }
  # OpenInputDesktop alone can return Default for a disconnected session.
  # Require WTSActive in our own session as well, and fail closed on unknown state.
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $buffer = [IntPtr]::Zero
  [uint32]$bytes = 0
  if (-not [MemmyExcelDesktop]::WTSQuerySessionInformation([IntPtr]::Zero, $session, 8, [ref]$buffer, [ref]$bytes)) { return $false }
  try {
    if ($buffer -eq [IntPtr]::Zero -or $bytes -lt 4 -or [Runtime.InteropServices.Marshal]::ReadInt32($buffer) -ne 0) { return $false }
  } finally { if ($buffer -ne [IntPtr]::Zero) { [MemmyExcelDesktop]::WTSFreeMemory($buffer) } }
  $desktop = [MemmyExcelDesktop]::OpenInputDesktop(0, $false, 1)
  if ($desktop -eq [IntPtr]::Zero) { return $false }
  try {
    $name = New-Object Text.StringBuilder 256
    [uint32]$needed = 0
    if (-not [MemmyExcelDesktop]::GetUserObjectInformation($desktop, 2, $name, 512, [ref]$needed)) { return $false }
    return [string]::Equals($name.ToString(), 'Default', [StringComparison]::OrdinalIgnoreCase)
  } finally { [void][MemmyExcelDesktop]::CloseDesktop($desktop) }
}

try {
  $encodedRequest = [Console]::In.ReadToEnd().Trim()
  if ($encodedRequest.Length -gt 900000) { throw 'Excel request is too large' }
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedRequest)) | ConvertFrom-Json
  if ($request.operation -notin @('status', 'invoke', 'authorize')) { throw 'Unsupported Excel operation' }
  $available = $null -ne [Type]::GetTypeFromProgID('Excel.Application', $false)
  $status = @{ available = $available; connected = $false; workbooks = @(); activeWorkbookId = $null }
  if (-not $available) {
    if ($request.operation -eq 'status') { Emit-Result $status; exit 0 }
    $failureCode = 'NOT_INSTALLED'
    throw 'Microsoft Excel is not installed'
  }
  if (-not (Interactive-Desktop)) {
    $failureCode = 'DESKTOP_UNAVAILABLE'
    throw 'Excel control requires an unlocked interactive Windows desktop'
  }
  $processes = @(Get-Process -Name EXCEL -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId })
  if ($processes.Count -gt 1) {
    $failureCode = 'MULTIPLE_INSTANCES'
    throw 'Multiple Excel application instances are running. Keep one Excel instance open to select a workbook safely.'
  }
  $app = $null
  if ($processes.Count -eq 0) {
    if ($request.operation -eq 'authorize') {
      $app = New-Object -ComObject Excel.Application
      Track-Com $app
      $app.Visible = $true
      # This instance belongs to the user after authorization, even after our
      # short-lived PowerShell process releases its final COM reference.
      $app.UserControl = $true
    } elseif ($request.operation -eq 'status') {
      Emit-Result $status
      exit 0
    } else {
      $failureCode = 'NOT_CONNECTED'
      throw 'Excel is not running. Open Excel and the workbook to control.'
    }
  } else {
    try {
      $app = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
      Track-Com $app
    } catch {
      $failureCode = 'NOT_CONNECTED'
      throw "The running Excel application is not available for control. HRESULT $($_.Exception.GetBaseException().HResult)"
    }
  }
  # Application.Hwnd can follow the active window in Excel's SDI interface.
  # Bind IDs to its process instead so switching workbooks does not rename every ID.
  [uint32]$excelProcess = 0
  [void][MemmyExcelDesktop]::GetWindowThreadProcessId([IntPtr]$app.Hwnd, [ref]$excelProcess)
  if ($excelProcess -eq 0 -or ($processes.Count -eq 1 -and $processes[0].Id -ne $excelProcess)) {
    $failureCode = 'INSTANCE_CHANGED'
    throw 'The Excel application instance changed. No changes were made.'
  }
  $instance = [string]$excelProcess
  $books = $app.Workbooks
  Track-Com $books
  $active = $app.ActiveWorkbook
  Track-Com $active
  $activeId = $null
  if ($null -ne $active) { $activeId = Workbook-Id $active $instance }
  $bookInfo = New-Object 'System.Collections.Generic.List[object]'
  $target = $null
  $targetId = $null
  if ($request.operation -eq 'invoke' -and [string]::IsNullOrEmpty([string]$request.action.workbook)) {
    $target = $active
    $targetId = $activeId
  }
  for ($i = 1; $i -le $books.Count; $i++) {
    $book = $books.Item($i)
    Track-Com $book
    $id = Workbook-Id $book $instance
    $bookInfo.Add(@{ id = $id; name = [string]$book.Name })
    if ($request.operation -eq 'invoke' -and $id -ceq [string]$request.action.workbook) {
      $target = $book
      $targetId = $id
    }
  }
  if ($request.operation -ne 'invoke') {
    Emit-Result @{ available = $true; connected = ($bookInfo.Count -gt 0); workbooks = @($bookInfo.ToArray()); activeWorkbookId = $activeId }
    exit 0
  }
  if ($null -eq $target) {
    $failureCode = 'WORKBOOK_NOT_FOUND'
    throw 'The requested Excel workbook is not open, or there is no active workbook. No changes were made.'
  }
  $action = $request.action
  if ($action.kind -notin @('selection', 'read_range', 'write_range')) { throw 'Unsupported Excel action' }
  if ($action.kind -eq 'selection') {
    if ([string]::IsNullOrEmpty([string]$action.workbook)) {
      $range = $app.Selection
      Track-Com $range
    } else {
      $windows = $target.Windows
      Track-Com $windows
      if ($windows.Count -lt 1) { throw 'The requested workbook has no window with a selection' }
      $window = $windows.Item(1)
      Track-Com $window
      $range = $window.RangeSelection
      Track-Com $range
    }
    if ($null -eq $range) { throw 'Select a cell range in Excel first' }
    $sheet = $range.Parent
    Track-Com $sheet
  } else {
    if ([string]::IsNullOrEmpty([string]$action.sheet)) {
      $sheet = $target.ActiveSheet
      Track-Com $sheet
    } else {
      $worksheets = $target.Worksheets
      Track-Com $worksheets
      $sheet = $worksheets.Item([string]$action.sheet)
      Track-Com $sheet
    }
    $range = $sheet.Range([string]$action.address)
    Track-Com $range
  }
  # Keep the captured workbook object throughout. Never activate a different workbook.
  $parentBook = $sheet.Parent
  Track-Com $parentBook
  if ((Workbook-Id $parentBook $instance) -cne $targetId) {
    $failureCode = 'WORKBOOK_CHANGED'
    throw 'The Excel selection belongs to a different workbook. No changes were made.'
  }
  $areas = $range.Areas
  Track-Com $areas
  if ($areas.Count -ne 1) { throw 'Excel control requires a single contiguous cell range' }
  $rangeRows = $range.Rows
  Track-Com $rangeRows
  $rangeColumns = $range.Columns
  Track-Com $rangeColumns
  $rowCount = [int]$rangeRows.Count
  $columnCount = [int]$rangeColumns.Count
  if ($rowCount -lt 1 -or $columnCount -lt 1 -or ([long]$rowCount * $columnCount) -gt 10000) {
    throw 'Excel range exceeds 10,000 cells'
  }
  $address = "'" + ([string]$sheet.Name).Replace("'", "''") + "'!" + $range.Address($false, $false, 1, $false)
  if ($action.kind -eq 'read_range') {
    $raw = $range.Value2
    $values = New-Object 'System.Collections.Generic.List[object]'
    $resultBytes = 0
    for ($r = 0; $r -lt $rowCount; $r++) {
      $row = New-Object object[] $columnCount
      for ($c = 0; $c -lt $columnCount; $c++) {
        $value = Cell-At $raw $r $c
        if ($null -ne $value -and $value -isnot [string] -and $value -isnot [bool] -and $value -isnot [ValueType]) {
          throw 'Excel returned an unsupported cell value'
        }
        # Value2 returns every number as a Double; an Int32 is an error cell (VT_ERROR).
        if ($value -is [int]) { $value = @{ error = $value } }
        $row[$c] = $value
      }
      $resultBytes += [Text.Encoding]::UTF8.GetByteCount((ConvertTo-Json -InputObject $row -Depth 3 -Compress)) + 1
      if ($resultBytes -gt 499000) { throw 'Excel range result is too large' }
      $values.Add($row)
    }
    $data = @{ workbookId = $targetId; address = $address; values = @($values.ToArray()) }
    # Value2 reports dates as serial numbers and formulas as their results. These
    # details are keyed by row-major cell index and never make a read fail.
    try {
      # Value is a parameterized COM property; 10 is xlRangeValueDefault.
      $formulas = @{}; $dates = @{}; $fs = $range.Formula; $vs = $null; try { $vs = $range.Value(10) } catch { }
      for ($r = 0; $r -lt $rowCount; $r++) { for ($c = 0; $c -lt $columnCount; $c++) {
        $k = "$($r * $columnCount + $c)"; $f = Cell-At $fs $r $c; $v = Cell-At $vs $r $c
        if ($f -is [string] -and $f.StartsWith('=') -and $f -cne [string]$values[$r][$c]) { $formulas[$k] = $f }
        if ($v -is [DateTime]) { $dates[$k] = $v.ToString('s') }
      } }
      if ($resultBytes + [Text.Encoding]::UTF8.GetByteCount((ConvertTo-Json -InputObject @($formulas, $dates) -Compress)) -lt 490000) {
        $data.formulas = $formulas; $data.dates = $dates
      } else { $data.note = 'Formulas and dates omitted; read a smaller range' }
    } catch { }
    Emit-Result $data
  } elseif ($action.kind -eq 'write_range') {
    if ($target.ReadOnly) { throw 'The requested Excel workbook is read-only. No changes were made.' }
    if ($action.values.Count -ne $rowCount) { throw 'Value dimensions do not match the Excel range' }
    $matrix = [Array]::CreateInstance([object], [int[]]@($rowCount, $columnCount))
    for ($r = 0; $r -lt $rowCount; $r++) {
      if ($action.values[$r].Count -ne $columnCount) { throw 'Value dimensions do not match the Excel range' }
      for ($c = 0; $c -lt $columnCount; $c++) {
        $value = $action.values[$r][$c]
        if ($value -is [string] -and $value.Length -gt 32000) { throw 'Excel cell text is limited to 32,000 characters' }
        $matrix.SetValue($value, $r, $c)
      }
    }
    # This final check precedes the only mutation, including writes to background workbooks.
    if ((Workbook-Id $target $instance) -cne $targetId) {
      $failureCode = 'WORKBOOK_CHANGED'
      throw 'The requested Excel workbook changed. No changes were made.'
    }
    if (-not (Interactive-Desktop)) {
      $failureCode = 'DESKTOP_UNAVAILABLE'
      throw 'Excel control requires an unlocked interactive Windows desktop'
    }
    $writeAttempted = $true
    $range.Value2 = $matrix
    Emit-Result @{ workbookId = $targetId; address = $address; rows = $rowCount; columns = $columnCount }
  } else {
    Emit-Result @{ workbookId = $targetId; address = $address; rows = $rowCount; columns = $columnCount }
  }
} catch {
  $message = [string]$_.Exception.Message
  if ($message.Length -gt 500) { $message = $message.Substring(0, 500) }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ok = $false; error = $message; code = $failureCode; writeAttempted = $writeAttempted } -Compress))
} finally {
  for ($i = $refs.Count - 1; $i -ge 0; $i--) {
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($refs[$i]) } catch { }
  }
  # Release only our COM references; never Quit or close the user's Excel instance.
}
`;

const POWERSHELL_ARGUMENTS = [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
  // Leave space below CreateProcess's command-line limit without altering any
  // executable statement or the C# here-string's delimiters.
  Buffer.from(WINDOWS_EXCEL_SCRIPT.split("\n").map(line => line.trimStart()).filter(line => line && !line.startsWith("#")).join("\n"), "utf16le").toString("base64"),
];

async function request(operation: Operation, action?: NativeAction, run?: WindowsExcelRunner, attachRetry = 0): Promise<unknown> {
  if (!run && process.platform !== "win32") throw new Error("Native Windows Excel control is supported on Windows only");
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const powershell = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const json = JSON.stringify({ operation, ...(action ? { action } : {}) });
  if (Buffer.byteLength(json) > 600_000) throw new Error("Excel request is too large");
  let output: string;
  try {
    output = await (run ?? (operation === "authorize" ? nativeExcelRunner({ timeoutMs: 60_000 }) : runNativeExcelCommand))(
      powershell, [...POWERSHELL_ARGUMENTS], Buffer.from(json, "utf8").toString("base64"),
    );
  } catch (error) {
    // Even a timed-out COM write might have finished. Never retry it automatically.
    if (operation === "invoke") throw new Error("Windows Excel control failed; the result is unknown and was not replayed", { cause: error });
    throw error;
  }
  if (Buffer.byteLength(output) > MAX_RESULT_BYTES) throw new Error("Excel response is too large; the result is unknown and was not replayed");
  let response: { ok?: unknown; data?: unknown; error?: unknown; code?: unknown; writeAttempted?: unknown };
  try { response = JSON.parse(output.trim()); } catch {
    throw new Error("Excel returned an invalid response; the result is unknown and was not replayed");
  }
  if (!response || typeof response !== "object" || typeof response.ok !== "boolean") {
    throw new Error("Excel returned an invalid response; the result is unknown and was not replayed");
  }
  if (!response.ok) {
    const detail = typeof response.error === "string" ? response.error.slice(0, 500) : "Windows Excel control failed";
    // A newly started Excel process may not yet be registered in the ROT.
    // Retry only connection probes with this exact pre-action failure.
    if (operation !== "invoke" && response.code === "NOT_CONNECTED"
      && detail.startsWith("The running Excel application is not available for control.") && attachRetry < 3) {
      await new Promise(resolve => setTimeout(resolve, 300));
      return request(operation, action, run, attachRetry + 1);
    }
    const message = EXCEL_BUSY_HRESULT.test(detail) ? EXCEL_BUSY : detail;
    throw new Error(response.writeAttempted === true
      ? `${message}; the result is unknown and was not replayed` : message);
  }
  return response.data;
}

function parseStatus(value: unknown): NativeWindowsExcelStatus {
  const data = value as Partial<NativeWindowsExcelStatus> | null;
  if (!data || typeof data.available !== "boolean" || typeof data.connected !== "boolean"
    || !Array.isArray(data.workbooks) || data.workbooks.some(book => !book || typeof book.id !== "string"
      || !book.id || typeof book.name !== "string" || !book.name)
    || !(data.activeWorkbookId === null || typeof data.activeWorkbookId === "string")) {
    throw new Error("Excel returned an invalid connection status");
  }
  const ids = new Set(data.workbooks.map(book => book.id));
  if (ids.size !== data.workbooks.length || (data.activeWorkbookId !== null && !ids.has(data.activeWorkbookId))
    || (!data.connected && (data.workbooks.length > 0 || data.activeWorkbookId !== null))
    || (data.connected && !data.available)) throw new Error("Excel returned an inconsistent connection status");
  return data as NativeWindowsExcelStatus;
}

export async function nativeWindowsExcelStatus(run?: WindowsExcelRunner): Promise<NativeWindowsExcelStatus> {
  if (!run && process.platform !== "win32") return { ...NO_CONNECTION, workbooks: [] };
  return parseStatus(await request("status", undefined, run));
}

export async function nativeWindowsExcelAuthorize(run?: WindowsExcelRunner): Promise<NativeWindowsExcelStatus> {
  return parseStatus(await request("authorize", undefined, run));
}

export async function nativeWindowsExcelRunning(run: WindowsExcelRunner = runNativeExcelCommand): Promise<boolean> {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  try {
    const output = await run(path.win32.join(root, "System32", "tasklist.exe"), ["/FI", "IMAGENAME eq EXCEL.EXE", "/FO", "CSV", "/NH"]);
    return /^"EXCEL\.EXE"/im.test(output);
  } catch { return false; }
}

export async function nativeWindowsExcelInvoke(action: NativeAction, run?: WindowsExcelRunner): Promise<unknown> {
  validateExcelAction(action);
  const value = await request("invoke", action, run);
  const result = value as {
    workbookId?: unknown; address?: unknown; values?: unknown; rows?: unknown; columns?: unknown;
    formulas?: unknown; dates?: unknown; note?: unknown;
  } | null;
  if (!result || typeof result !== "object" || typeof result.workbookId !== "string" || !result.workbookId
    || result.workbookId.length > 4096 || /[\u0000-\u001f]/.test(result.workbookId)) {
    throw new Error("Excel returned a result without a workbook id; the result is unknown and was not replayed");
  }
  if (action.workbook !== undefined && result.workbookId !== action.workbook) {
    throw new Error("Excel returned a result for a different workbook; the result is unknown and was not replayed");
  }
  const invalid = () => { throw new Error("Excel returned invalid range data; the result is unknown and was not replayed"); };
  if (typeof result.address !== "string" || !result.address || result.address.length > 256) invalid();
  let expectedRows = 0;
  let expectedColumns = 0;
  if (action.kind !== "selection") {
    // The shared validator has already checked syntax and Excel's row/column bounds.
    const points = action.address.replaceAll("$", "").toUpperCase().split(":");
    const point = (text: string) => {
      const match = /^([A-Z]+)(\d+)$/.exec(text)!;
      const column = [...match[1]].reduce((number, character) => number * 26 + character.charCodeAt(0) - 64, 0);
      return { column, row: Number(match[2]) };
    };
    const first = point(points[0]);
    const last = point(points.at(-1)!);
    expectedRows = last.row - first.row + 1;
    expectedColumns = last.column - first.column + 1;
  }
  if (action.kind === "read_range") {
    const errorCode = (cell: unknown): number | null => cell && typeof cell === "object" && !Array.isArray(cell)
      && Object.keys(cell).length === 1 && Number.isInteger((cell as { error?: unknown }).error) ? (cell as { error: number }).error : null;
    const raw = result.values;
    if (!Array.isArray(raw) || raw.length !== expectedRows || raw.some(row => !Array.isArray(row)
      || row.length !== expectedColumns || row.some(cell => cell !== null && typeof cell !== "string"
        && typeof cell !== "boolean" && !(typeof cell === "number" && Number.isFinite(cell)) && errorCode(cell) === null))) invalid();
    const values = (raw as unknown[][]).map(row => row.map(cell => {
      const code = errorCode(cell);
      return code === null ? cell : excelErrorText(code);
    }));
    let details: ExcelReadDetails;
    try { details = excelReadDetails(result, action.address); } catch { return invalid(); }
    return { workbookId: result.workbookId, address: result.address, values, ...details };
  } else {
    if (typeof result.rows !== "number" || !Number.isInteger(result.rows) || result.rows < 1
      || typeof result.columns !== "number" || !Number.isInteger(result.columns) || result.columns < 1
      || result.rows * result.columns > 10_000) invalid();
    if (action.kind === "write_range" && (result.rows !== expectedRows || result.columns !== expectedColumns)) invalid();
  }
  return value;
}
