import { EXCEL_CONNECTION_SETTINGS_LINK } from "@memmy/local-api-contracts";
import { Tool, type ToolExecutionContext } from "./base.js";
import { RequestContextStore, type RequestContext } from "./context.js";
import { type ExcelBridgeAction } from "../../../tools/computer-use/excel-bridge.js";
import { nativeExcelControl } from "../../../tools/computer-use/excel-native-control.js";
import { nativeAppTurnKey, requestNativeAppAccess, type NativeAppIdentity } from "../../../tools/computer-use/native-app-approvals.js";

const MAC_EXCEL: NativeAppIdentity = { platform: "darwin", appId: "com.microsoft.Excel", displayName: "Microsoft Excel" };
const WINDOWS_EXCEL: NativeAppIdentity = { platform: "win32", appId: "excel.exe", displayName: "Microsoft Excel" };
const NOT_OPEN = "Microsoft Excel is not open, so there is no workbook to read. Ask for the workbook file instead.";
const OFF = "Microsoft Excel access is off and this request cannot ask the user. Continue with a workbook file if one fits; offer the Excel connection link once if live access is needed.";
const NOT_ALLOWED = "Microsoft Excel access was not allowed for this request. Do not ask again in this turn; continue with a workbook file if one fits.";

type ConnectionSetup = {
  settingsLink: typeof EXCEL_CONNECTION_SETTINGS_LINK;
  reason: "disabled" | "permission-required";
  note: string;
};
type Access = { granted: boolean; note?: string; connectionSetup?: ConnectionSetup };

function connectionSetup(reason: ConnectionSetup["reason"]): ConnectionSetup {
  return { settingsLink: EXCEL_CONNECTION_SETTINGS_LINK, reason,
    note: reason === "disabled"
      ? "Offer settingsLink once as a Markdown link to enable Excel access. An attached workbook does not require this connection."
      : "Offer settingsLink as a Markdown link to check Excel authorization, then end this turn and wait for a new user message." };
}

function permissionFailure(message: string): boolean {
  return /-174[34]|automation.*(?:denied|permission)|not authorized to send apple events/i.test(message);
}

/** Keep the rejection and its original error; the runtime forwards its message. */
function withConnectionLink(error: unknown, reason: ConnectionSetup["reason"]): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  if (!original.message.includes(EXCEL_CONNECTION_SETTINGS_LINK)) {
    original.message += reason === "disabled"
      ? ` Open [开启 Excel 连接](${EXCEL_CONNECTION_SETTINGS_LINK}) if live workbook access is needed.`
      : ` Check [检查 Excel 连接授权](${EXCEL_CONNECTION_SETTINGS_LINK}), then send a new message to retry.`;
  }
  return original;
}

/**
 * The application permission covers every workbook already open in Excel.
 * Operations never open a file, activate another workbook, or replay a write.
 */
export class ExcelLiveTool extends Tool {
  private readonly requestContext = new RequestContextStore();
  // One in-app decision per user message, so parallel calls share a single prompt.
  private readonly decisions = new Map<string, Promise<Access>>();

  setContext(context: RequestContext): void { this.requestContext.set(context); }

  get name(): string { return "excel_live"; }
  get description(): string {
    return "Read or change cells (values and formulas) of a workbook the user has open in Microsoft Excel, including unsaved edits and the current selection. "
      + "Changes appear in the user's window at once; an attached or delivered workbook file is a separate copy that this tool does not touch. "
      + "Call status first and pass its exact workbook ID; writes require it. Use a bounded A1 range of up to 10,000 cells. "
      + "read_range returns raw values, with date cells as serial numbers, plus formulas and dates by cell. "
      + "An error cell reads as text such as #NAME? on Windows and as empty text on Mac, where its formula still appears. "
      + "write_range enters each string as if typed into the cell: = starts an English formula, Excel converts date and number text, and a leading ' keeps text as written. "
      + "The existing exec tool can also call Excel's native automation interfaces for formatting, charts, rows, columns and worksheets: AppleScript/JXA on macOS and PowerShell COM on Windows. "
      + "This tool's cell parameter schema does not describe the full capabilities of Excel. "
      + "If Excel is open but not yet allowed, Memmy asks the user in the app. When access was not allowed, do not ask again in this turn or reach Excel another way. "
      + "When a result includes connectionSetup, briefly explain its reason in the user's language and include connectionSetup.settingsLink as a Markdown link, such as [开启 Excel 连接](memmy://settings/excel) or [检查 Excel 连接授权](memmy://settings/excel). "
      + "Do not quote enabled, configured or setupCompleted fields to the user or give a long menu walkthrough. Excel being closed or having no workbook does not mean the connection needs enabling; an attached file does not require this connection. "
      + "If the operating system denies permission, offer the authorization link and end this turn. "
      + "A failed, cancelled or timed-out write may still have been applied; read the range before writing it again.";
  }
  get parameters() {
    return {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["status", "selection", "read_range", "write_range"] },
        workbook: { type: "string", description: "Exact workbook ID returned by status; required for write_range" },
        address: { type: "string", description: "Bounded A1 address for read_range or write_range" },
        sheet: { type: "string", description: "Optional worksheet name; default is the active worksheet" },
        values: {
          type: "array", description: "Rectangular cell values for write_range; null clears a cell, \"=SUM(D3:D10)\" writes a formula, \"'2026-10-11\" stores text",
          items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
        },
      },
      required: ["operation"],
    };
  }
  async execute(params: Record<string, any>, context?: ToolExecutionContext): Promise<any> {
    try {
      if (params.operation !== "status" && context?.abortSignal?.aborted) throw new Error("Excel operation cancelled before dispatch");
      const access = await this.access();
      if (params.operation === "status") {
        const status = await nativeExcelControl.status({ granted: access.granted });
        const permissionFailureReported = access.note !== NOT_OPEN && access.note !== NOT_ALLOWED
          && (status.permissionRequired || permissionFailure(status.error ?? ""));
        // A previous Automation error can stay cached after Excel closes.
        const closedAfterFailure = permissionFailureReported && !await nativeExcelControl.running();
        const permissionRequired = permissionFailureReported && !closedAfterFailure;
        const setup = closedAfterFailure ? undefined : permissionRequired
          ? connectionSetup("permission-required") : access.connectionSetup;
        if (setup?.reason === "permission-required") {
          context?.stopTurn?.(withConnectionLink(status.error ?? "Microsoft Excel automation permission is required", setup.reason).message);
        }
        const note = closedAfterFailure ? NOT_OPEN : access.note;
        return { ...status, ...(note ? { note } : {}), ...(setup ? { connectionSetup: setup } : {}) };
      }
      if (access.note) throw access.connectionSetup
        ? withConnectionLink(new Error(access.note), access.connectionSetup.reason) : new Error(access.note);
      let action: ExcelBridgeAction;
      if (params.operation === "selection") action = { kind: "selection" };
      else if (params.operation === "read_range") {
        action = { kind: "read_range", address: params.address, sheet: params.sheet };
      } else if (params.operation === "write_range") {
        action = { kind: "write_range", address: params.address, sheet: params.sheet, values: params.values };
      } else throw new Error("Unsupported Excel operation");
      action.workbook = params.workbook;
      // A cancelled or timed-out dispatched action is uncertain. Never retry it automatically.
      return await nativeExcelControl.invoke(action, context?.abortSignal, { granted: access.granted });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (permissionFailure(message)) {
        const guidedError = withConnectionLink(error, "permission-required");
        context?.stopTurn?.(guidedError.message);
        throw guidedError;
      }
      if (message.startsWith("Enable Microsoft Excel in Memmy Computer Use settings first.")) {
        throw withConnectionLink(error, "disabled");
      }
      throw error;
    }
  }

  /** The Computer Use setting, or the user's in-app decision for this message while Excel is open. */
  private async access(): Promise<Access> {
    if (await nativeExcelControl.isEnabled()) return { granted: false };
    const turn = nativeAppTurnKey(this.requestContext.get());
    if (!turn) return await nativeExcelControl.running()
      ? { granted: false, note: OFF, connectionSetup: connectionSetup("disabled") }
      : { granted: false, note: NOT_OPEN };
    let decision = this.decisions.get(turn);
    if (!decision) {
      decision = this.decide();
      this.decisions.set(turn, decision);
      if (this.decisions.size > 256) this.decisions.delete(this.decisions.keys().next().value!);
    }
    return decision;
  }

  private async decide(): Promise<Access> {
    if (!await nativeExcelControl.running()) return { granted: false, note: NOT_OPEN };
    const decision = await requestNativeAppAccess(process.platform === "win32" ? WINDOWS_EXCEL : MAC_EXCEL);
    if (decision === "allow-always") {
      await nativeExcelControl.setEnabled(true);
      return { granted: false };
    }
    if (decision !== "allow-once") return { granted: false, note: NOT_ALLOWED };
    await nativeExcelControl.authorizeOnce();
    return { granted: true };
  }
}
