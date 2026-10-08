import { Tool, type ToolExecutionContext } from "./base.js";
import { excelBridge, type ExcelBridgeAction } from "../../../tools/computer-use/excel-bridge.js";

/**
 * The Office.js task pane owns workbook access. This tool never opens a file
 * or attaches to an arbitrary Excel process; the user must connect a workbook.
 */
export class ExcelLiveTool extends Tool {
  get name(): string { return "excel_live"; }
  get description(): string {
    return "Inspect or edit the one Excel workbook the user currently has open with Memmy. "
      + "Call status first. If it is not connected, ask the user to turn on Microsoft Excel in Computer Use, reopen Excel, and click Memmy in the Insert menu. "
      + "Do not say add-in. Use a bounded A1 range for read_range and write_range.";
  }
  get parameters() {
    return {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["status", "selection", "read_range", "write_range"] },
        address: { type: "string", description: "Bounded A1 address for read_range or write_range" },
        sheet: { type: "string", description: "Optional worksheet name; default is the active worksheet" },
        values: {
          type: "array", description: "Rectangular cell values for write_range",
          items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
        },
      },
      required: ["operation"],
    };
  }
  async execute(params: Record<string, any>, context?: ToolExecutionContext): Promise<any> {
    if (params.operation === "status") return excelBridge.status();
    if (context?.abortSignal?.aborted) throw new Error("Excel operation cancelled before dispatch");
    let action: ExcelBridgeAction;
    if (params.operation === "selection") action = { kind: "selection" };
    else if (params.operation === "read_range") {
      action = { kind: "read_range", address: params.address, sheet: params.sheet };
    } else if (params.operation === "write_range") {
      action = { kind: "write_range", address: params.address, sheet: params.sheet, values: params.values };
    } else throw new Error("Unsupported Excel operation");
    // A cancelled or timed-out dispatched action is uncertain. Never retry it automatically.
    return excelBridge.invoke(action);
  }
}
