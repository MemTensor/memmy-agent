import { excelReadDetails, validateExcelAction, type ExcelBridgeAction } from "./excel-bridge.js";
import { nativeExcelRunner, runNativeExcelCommand, type NativeExcelRunner, type NativeExcelStatus } from "./excel-native-runtime.js";

const MAX_DATA_BYTES = 500_000;
const PROTOCOL = "memmy.excel.mac.v1";

/** Excel.sdef names: full name, active workbook/sheet, areas, value2, formula, value and get address.
 * The script is fixed. Workbook names, addresses and cell values arrive as JSON
 * on stdin and are never interpolated into executable JavaScript or AppleScript.
 */
export const MAC_EXCEL_SCRIPT = String.raw`
ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
ObjC.import("ApplicationServices");
// The generated CoreGraphics bridge returns a CF Ref. NSDictionary is toll-free
// bridged, so binding the result as id makes its real keys available to JXA.
ObjC.bindFunction("CGSessionCopyCurrentDictionary", ["id", []]);
ObjC.bindFunction("AEDeterminePermissionToAutomateTarget", ["int", ["void *", "unsigned int", "unsigned int", "bool"]]);
function run() {
  var writeAttempted = false;
  function fail(message, code) { var error = new Error(message); error.nativeCode = code; throw error; }
  function byteLength(value) { return unescape(encodeURIComponent(value)).length; }
  function unlocked() {
    var session = ObjC.deepUnwrap($.CGSessionCopyCurrentDictionary());
    if (!session || (session.kCGSSessionOnConsoleKey !== true && session.kCGSSessionOnConsoleKey !== 1) ||
        (session.kCGSessionLoginDoneKey !== true && session.kCGSessionLoginDoneKey !== 1)) {
      fail("The unlocked macOS login session could not be verified; Excel operation was not executed", "sessionUnknown");
    }
    // macOS omits this key for an unlocked session. Any unexpected value fails closed.
    var locked = session.CGSSessionScreenIsLocked;
    if (locked !== undefined && locked !== false && locked !== 0) {
      fail("macOS is locked; Excel operation was not executed", "sessionLocked");
    }
  }
  function permission(askUserIfNeeded) {
    var target = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier("com.microsoft.Excel");
    var code = $.AEDeterminePermissionToAutomateTarget(target.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, askUserIfNeeded === true);
    if (code === -1744) fail("Automation permission required (-1744). Retry Excel authorization and allow Memmy to control Microsoft Excel in the system prompt", code);
    if (code === -1743) fail("Automation denied (-1743). Allow Memmy to control Microsoft Excel in System Settings > Privacy & Security > Automation, then retry Excel authorization", code);
    if (code !== 0) fail("Excel Automation permission could not be verified (" + code + "); Excel operation was not executed", code);
  }
  // Excel cannot resolve the object references it returns (activeWorkbook(),
  // activeSheet(), selection()); sending one back fails with -1728. Follow
  // property paths such as excel.activeWorkbook.name() instead.
  function existing(read, message, code) {
    try { return read(); } catch (error) { if (error.errorNumber === -1728) fail(message, code); throw error; }
  }
  function identity(book) { var fullName = book.fullName(); return typeof fullName === "string" && fullName ? fullName : book.name(); }
  function fixedBook(excel, reference, expected) {
    var found = existing(function() { return { name: reference.name(), id: identity(reference) }; },
      expected === undefined ? "No Excel workbook is active; pass a workbook ID from status" : "The requested Excel workbook is not open", "workbookMissing");
    if (expected !== undefined && found.id !== expected) fail("The requested Excel workbook is not open", "workbookMissing");
    var book = excel.workbooks.byName(found.name);
    if (identity(book) !== found.id) fail("The Excel workbook changed before dispatch; operation was not executed", "workbookChanged");
    return { book: book, id: found.id, name: found.name };
  }
  function dimensions(address) {
    var match = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})(?::\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6}))?$/i.exec(address);
    if (!match) fail("Excel selection must be one bounded A1 range", "invalidRange");
    function column(value) { var result = 0; for (var index = 0; index < value.length; index++) result = result * 26 + value.toUpperCase().charCodeAt(index) - 64; return result; }
    var left = column(match[1]), top = Number(match[2]), right = match[3] ? column(match[3]) : left, bottom = match[4] ? Number(match[4]) : top;
    if (left > 16384 || right > 16384 || top > 1048576 || bottom > 1048576 || right < left || bottom < top || (right - left + 1) * (bottom - top + 1) > 10000) fail("Excel range exceeds the supported worksheet bounds or 10,000 cells", "invalidRange");
    return { rows: bottom - top + 1, columns: right - left + 1, left: left, top: top };
  }
  function columnName(value) { var result = ""; while (value > 0) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); } return result; }
  function scalar(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && isFinite(value))) return value;
    fail("Excel returned an unsupported cell value", "invalidValue");
  }
  function grid(raw, size) {
    // Excel returns a scalar for one cell; range values otherwise use row lists.
    if (size.rows === 1 && size.columns === 1) {
      if (Array.isArray(raw)) raw = Array.isArray(raw[0]) ? raw[0][0] : raw[0];
      return [[raw]];
    }
    if (!Array.isArray(raw)) fail("Excel returned an invalid range matrix", "invalidValue");
    if (size.rows === 1 && raw.length === size.columns && !Array.isArray(raw[0])) raw = [raw];
    if (size.columns === 1 && raw.length === size.rows && !Array.isArray(raw[0])) raw = raw.map(function(value) { return [value]; });
    if (raw.length !== size.rows) fail("Excel returned an invalid range matrix", "invalidValue");
    return raw.map(function(row) {
      if (!Array.isArray(row) || row.length !== size.columns) fail("Excel returned an invalid range matrix", "invalidValue");
      return row;
    });
  }
  function matrix(raw, size) { return grid(raw, size).map(function(row) { return row.map(scalar); }); }
  function sortable(date) {
    function pad(number) { return (number < 10 ? "0" : "") + number; }
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }
  // value2 reports dates as serial numbers and formulas as their results. These
  // details are keyed by row-major cell index and never make a read fail.
  function details(range, size, values) {
    try {
      var formulas = grid(range.formula(), size), typed = grid(range.value(), size), found = { formulas: {}, dates: {} };
      for (var row = 0; row < size.rows; row++) {
        for (var column = 0; column < size.columns; column++) {
          var key = String(row * size.columns + column), formula = formulas[row][column], value = typed[row][column];
          if (typeof formula === "string" && formula.charAt(0) === "=" && formula !== String(values[row][column])) found.formulas[key] = formula;
          if (Object.prototype.toString.call(value) === "[object Date]" && isFinite(value.getTime())) found.dates[key] = sortable(value);
        }
      }
      return found;
    } catch (error) { return {}; }
  }
  function quotedAddress(sheet, address) { return "'" + sheet.name().replace(/'/g, "''") + "'!" + address; }
  try {
    var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding));
    if (!text || byteLength(text) > 500000) fail("Excel request is too large", "requestTooLarge");
    var request = JSON.parse(text);
    if (request.operation !== "status" && request.operation !== "authorize" && request.operation !== "invoke") fail("Invalid Excel operation", "invalidOperation");
    unlocked();
    var url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier("com.microsoft.Excel");
    var available = !!ObjC.unwrap(url.path);
    if (!available) {
      if (request.operation !== "status") fail("Microsoft Excel is not installed", "excelUnavailable");
      return JSON.stringify({ protocol: "memmy.excel.mac.v1", ok: true, data: { available: false, connected: false, workbooks: [], activeWorkbookId: null } });
    }
    var excel = Application("com.microsoft.Excel");
    if (request.operation === "authorize") {
      // launch() does not send open/reopen or activate and does not open a workbook.
      if (!excel.running()) excel.launch();
      unlocked();
    }
    if (!excel.running()) {
      if (request.operation === "authorize") fail("Microsoft Excel did not start; open Excel and retry authorization", "excelNotRunning");
      if (request.operation === "invoke") fail("Microsoft Excel is not running; open Excel and the workbook first", "excelNotRunning");
      return JSON.stringify({ protocol: "memmy.excel.mac.v1", ok: true, data: { available: true, connected: false, workbooks: [], activeWorkbookId: null } });
    }
    // A name read can be exempt from consent. Explicit authorization requests the
    // full grant; status and controls only check it and never request a prompt.
    permission(request.operation === "authorize");
    unlocked();
    var result;
    if (request.operation === "status" || request.operation === "authorize") {
      var books = [];
      for (var index = 0; index < excel.workbooks.length; index++) {
        unlocked();
        var item = excel.workbooks.at(index);
        books.push({ id: identity(item), name: item.name() });
      }
      var activeId = null;
      // A hidden workbook, such as a personal macro workbook, has no active window.
      if (books.length) {
        try { activeId = identity(excel.activeWorkbook); } catch (error) { if (error.errorNumber !== -1728) throw error; }
      }
      result = { available: true, connected: books.length > 0, workbooks: books, activeWorkbookId: activeId };
    } else {
      var action = request.action;
      var target;
      if (action.workbook !== undefined) {
        // Resolve by name, then compare its full identity. Never activate another workbook.
        var requestedName = action.workbook.split(/[\/:]/).pop();
        target = fixedBook(excel, excel.workbooks.byName(requestedName), action.workbook);
      } else {
        target = fixedBook(excel, excel.activeWorkbook);
      }
      var sheet, sheetName, range, address, size;
      if (action.kind === "selection") {
        if (identity(excel.activeWorkbook) !== target.id) fail("Selection is available only in the active workbook; the requested workbook was not activated", "selectionWorkbookMismatch");
        range = excel.selection;
        sheetName = existing(function() { return range.worksheetObject.name(); }, "Select cells in an Excel worksheet first", "invalidSelection");
        var areas = range.areas();
        if (!Array.isArray(areas) || areas.length !== 1) fail("Select one contiguous Excel range; multiple areas are ambiguous", "multipleAreas");
        address = excel.getAddress(range, { rowAbsolute: true, columnAbsolute: true, external: false });
        size = dimensions(address);
        if (identity(excel.activeWorkbook) !== target.id || range.worksheetObject.name() !== sheetName) fail("The Excel selection moved to another workbook or sheet while it was being read", "selectionChanged");
        sheet = target.book.worksheets.byName(sheetName);
        result = { workbookId: target.id, address: quotedAddress(sheet, address), rows: size.rows, columns: size.columns };
      } else {
        sheetName = existing(function() { return (action.sheet !== undefined ? target.book.worksheets.byName(action.sheet) : target.book.activeSheet).name(); },
          action.sheet !== undefined ? "The requested Excel worksheet does not exist" : "The Excel workbook has no active worksheet; pass a sheet name", "sheetMissing");
        // Rebind a concrete worksheet before obtaining the range; never use app-global ranges.
        sheet = target.book.worksheets.byName(sheetName);
        address = action.address;
        size = dimensions(address);
        range = sheet.ranges.byName(address);
        if (action.kind === "read_range") {
          var cells = matrix(range.value2(), size), extra = details(range, size, cells);
          result = { workbookId: target.id, address: quotedAddress(sheet, address), values: cells, formulas: extra.formulas, dates: extra.dates };
        } else if (action.kind === "write_range") {
          if (identity(target.book) !== target.id) fail("The Excel workbook changed before writing; operation was not executed", "workbookChanged");
          // Excel accepts a rectangular value2 list. Null cells are explicitly cleared
          // afterwards, since the Apple Event representation of JS null isn't portable.
          var values = action.values.map(function(row) { return row.map(function(value) { return value === null ? "" : value; }); });
          permission(false);
          unlocked();
          writeAttempted = true;
          range.value2 = size.rows === 1 && size.columns === 1 ? values[0][0] : values;
          for (var rowIndex = 0; rowIndex < size.rows; rowIndex++) {
            var columnIndex = 0;
            while (columnIndex < size.columns) {
              if (action.values[rowIndex][columnIndex] !== null) { columnIndex++; continue; }
              var start = columnIndex;
              while (columnIndex < size.columns && action.values[rowIndex][columnIndex] === null) columnIndex++;
              unlocked();
              var first = columnName(size.left + start) + (size.top + rowIndex);
              var last = columnName(size.left + columnIndex - 1) + (size.top + rowIndex);
              excel.clearContents(sheet.ranges.byName(first === last ? first : first + ":" + last));
            }
          }
          result = { workbookId: target.id, address: quotedAddress(sheet, address), rows: size.rows, columns: size.columns };
        } else fail("Unsupported Excel action", "invalidOperation");
      }
    }
    var response = JSON.stringify({ protocol: "memmy.excel.mac.v1", ok: true, data: result });
    if (byteLength(response) > 500000 && (result.formulas || result.dates)) {
      delete result.formulas;
      delete result.dates;
      result.note = "Formulas and dates were omitted because the range is large; read a smaller range to see them";
      response = JSON.stringify({ protocol: "memmy.excel.mac.v1", ok: true, data: result });
    }
    if (byteLength(response) > 500000) fail("Excel result exceeds 500,000 bytes", "responseTooLarge");
    return response;
  } catch (error) {
    var code = error.nativeCode !== undefined ? error.nativeCode : error.errorNumber;
    var message = String(error.message || error);
    if (code === -1743 || /-1743/.test(message)) { code = -1743; message = "Automation denied (-1743). Allow Memmy to control Microsoft Excel in System Settings > Privacy & Security > Automation, then retry Excel authorization"; }
    if (code === -1744 || /-1744/.test(message)) { code = -1744; message = "Automation permission required (-1744). Retry Excel authorization and allow Memmy to control Microsoft Excel in the system prompt"; }
    if (writeAttempted) message = message.slice(0, 400) + "; result is unknown and was not replayed";
    return JSON.stringify({ protocol: "memmy.excel.mac.v1", ok: false, error: { code: code, message: message.slice(0, 500), resultUnknown: writeAttempted } });
  }
}
`;

async function requestMacExcel(operation: "status" | "authorize" | "invoke", run: NativeExcelRunner, action?: ExcelBridgeAction): Promise<unknown> {
  const input = JSON.stringify({ operation, ...(action ? { action } : {}) });
  if (Buffer.byteLength(input, "utf8") > MAX_DATA_BYTES) throw new Error("Excel request exceeds 500,000 bytes");
  let output: string;
  try {
    output = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_EXCEL_SCRIPT], input);
  } catch (error) {
    if (/-1743/.test(String((error as Error)?.message ?? error))) throw Object.assign(new Error("Automation denied (-1743). Allow Memmy to control Microsoft Excel in System Settings > Privacy & Security > Automation, then retry Excel authorization" + (action?.kind === "write_range" ? "; result is unknown and was not replayed" : "")), { code: -1743, resultUnknown: action?.kind === "write_range" });
    if (/-1744/.test(String((error as Error)?.message ?? error))) throw Object.assign(new Error("Automation permission required (-1744). Retry Excel authorization and allow Memmy to control Microsoft Excel in the system prompt" + (action?.kind === "write_range" ? "; result is unknown and was not replayed" : "")), { code: -1744, resultUnknown: action?.kind === "write_range" });
    if (action?.kind === "write_range") throw uncertainWrite(error);
    throw error; // No retries: a timed-out write may already have reached Excel.
  }
  const invalidResult = (message: string): Error => action?.kind === "write_range" ? uncertainWrite(new Error(message)) : new Error(message);
  if (Buffer.byteLength(output, "utf8") > MAX_DATA_BYTES) throw invalidResult("Excel result exceeds 500,000 bytes");
  let response: any;
  try { response = JSON.parse(output); } catch { throw invalidResult("Excel returned an invalid native response"); }
  if (!response || response.protocol !== PROTOCOL || typeof response.ok !== "boolean") throw invalidResult("Excel returned an invalid native response");
  if (!response.ok) {
    const error = Object.assign(new Error(typeof response.error?.message === "string" ? response.error.message.slice(0, 500) : "Excel native operation failed"), { code: response.error?.code, resultUnknown: response.error?.resultUnknown === true });
    throw response.error?.resultUnknown === true ? uncertainWrite(error) : error;
  }
  return response.data;
}

function checkStatus(value: unknown): NativeExcelStatus {
  const result = value as NativeExcelStatus;
  if (!result || typeof result.available !== "boolean" || typeof result.connected !== "boolean" || !Array.isArray(result.workbooks)
    || result.workbooks.some(book => !book || !validIdentity(book.id) || typeof book.name !== "string" || !book.name || book.name.length > 255)
    || (result.activeWorkbookId !== null && !validIdentity(result.activeWorkbookId))
    || new Set(result.workbooks.map(book => book.id)).size !== result.workbooks.length
    || result.connected !== (result.available && result.workbooks.length > 0)
    || (!result.available && result.workbooks.length > 0)
    || (result.activeWorkbookId !== null && !result.workbooks.some(book => book.id === result.activeWorkbookId))) throw new Error("Excel returned an invalid workbook status");
  return result;
}

export async function nativeMacExcelStatus(run: NativeExcelRunner = runNativeExcelCommand): Promise<NativeExcelStatus> {
  return checkStatus(await requestMacExcel("status", run));
}

export async function nativeMacExcelAuthorize(run: NativeExcelRunner = nativeExcelRunner({ timeoutMs: 60_000 })): Promise<NativeExcelStatus> {
  return checkStatus(await requestMacExcel("authorize", run));
}

/** LaunchServices answers this without an Apple Event, so it needs no Automation consent. */
export async function nativeMacExcelRunning(run: NativeExcelRunner = runNativeExcelCommand): Promise<boolean> {
  try { return (await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", 'Application("com.microsoft.Excel").running()'])).trim() === "true"; }
  catch { return false; }
}

export async function nativeMacExcelInvoke(action: ExcelBridgeAction, run: NativeExcelRunner = runNativeExcelCommand): Promise<unknown> {
  validateExcelAction(action);
  const result = await requestMacExcel("invoke", run, action) as any;
  try {
    if (!result || !validIdentity(result.workbookId)) throw new Error("Excel returned a result without a workbook identity");
    if (action.workbook !== undefined && result.workbookId !== action.workbook) throw new Error("Excel returned a result from a different workbook");
    const size = resultDimensions(result.address);
    if (action.kind !== "selection" && size.address !== action.address.replace(/\$/g, "").toUpperCase()) throw new Error("Excel returned a different range");
    if (action.kind === "read_range") {
      if (!Array.isArray(result.values) || result.values.length !== size.rows || result.values.some((row: unknown) => !Array.isArray(row) || row.length !== size.columns || row.some(value => value !== null && typeof value !== "string" && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) || row.some(value => typeof value === "string" && value.length > 32_000))) throw new Error("Excel returned an invalid range matrix");
      return { workbookId: result.workbookId, address: result.address, values: result.values, ...excelReadDetails(result, action.address) };
    }
    if (result.rows !== size.rows || result.columns !== size.columns) throw new Error("Excel returned invalid range dimensions");
    return result;
  } catch (error) { throw action.kind === "write_range" ? uncertainWrite(error) : error; }
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 4096 && !/[\u0000-\u001f]/.test(value);
}

function uncertainWrite(error: unknown): Error {
  const message = String((error as Error)?.message ?? error);
  return Object.assign(new Error(message.includes("result is unknown") || message.includes("result may be unknown") ? message : `${message}; result is unknown and was not replayed`), { code: (error as any)?.code, resultUnknown: true });
}

function resultDimensions(value: unknown): { rows: number; columns: number; address: string } {
  if (typeof value !== "string" || value.length > 128 || !value.includes("!")) throw new Error("Excel returned an invalid range address");
  const address = value.slice(value.lastIndexOf("!") + 1);
  validateExcelAction({ kind: "read_range", address });
  const [first, last = first] = address.replace(/\$/g, "").toUpperCase().split(":");
  const cell = (text: string): [number, number] => {
    const match = /^([A-Z]+)([0-9]+)$/.exec(text)!;
    return [Array.from(match[1]).reduce((sum, character) => sum * 26 + character.charCodeAt(0) - 64, 0), Number(match[2])];
  };
  const [left, top] = cell(first), [right, bottom] = cell(last);
  return { rows: bottom - top + 1, columns: right - left + 1, address: address.replace(/\$/g, "").toUpperCase() };
}
