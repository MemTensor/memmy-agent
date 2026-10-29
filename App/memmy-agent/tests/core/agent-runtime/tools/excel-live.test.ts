import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXCEL_CONNECTION_SETTINGS_LINK } from "@memmy/local-api-contracts";

vi.mock("../../../../src/tools/computer-use/native-app-approvals.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../../src/tools/computer-use/native-app-approvals.js")>(),
  requestNativeAppAccess: vi.fn(),
}));

import { ExcelLiveTool } from "../../../../src/core/agent-runtime/tools/excel-live.js";
import { RequestContext } from "../../../../src/core/agent-runtime/tools/context.js";
import { nativeExcelControl } from "../../../../src/tools/computer-use/excel-native-control.js";
import { requestNativeAppAccess } from "../../../../src/tools/computer-use/native-app-approvals.js";

const scope = { sessionKey: "websocket:chat", channel: "websocket", chatId: "chat" };
let enabled = false;

function tool(messageId = "first", metadata: Record<string, unknown> = {}): ExcelLiveTool {
  const excel = new ExcelLiveTool();
  excel.setContext(new RequestContext({ ...scope, messageId, metadata }));
  return excel;
}

beforeEach(() => {
  enabled = false;
  vi.mocked(requestNativeAppAccess).mockReset();
  vi.spyOn(nativeExcelControl, "isEnabled").mockImplementation(async () => enabled);
  vi.spyOn(nativeExcelControl, "running").mockResolvedValue(true);
  vi.spyOn(nativeExcelControl, "status").mockImplementation(async (options = {}) => {
    const active = enabled || options.granted === true;
    return { available: true, enabled: active, configured: active, setupCompleted: enabled, connected: active,
      workbooks: active ? [{ id: "工作簿1", name: "工作簿1" }] : [], activeWorkbookId: active ? "工作簿1" : null,
      permissionRequired: false, error: null } as any;
  });
  vi.spyOn(nativeExcelControl, "invoke").mockResolvedValue({ workbookId: "工作簿1", values: [[1]] });
  vi.spyOn(nativeExcelControl, "setEnabled").mockImplementation(async () => { enabled = true; return {} as any; });
  vi.spyOn(nativeExcelControl, "authorizeOnce").mockResolvedValue({} as any);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("excel_live access", () => {
  it("uses the Computer Use setting without asking", async () => {
    enabled = true;
    const excel = tool();
    const status = await excel.execute({ operation: "status" });
    expect(status).toMatchObject({ enabled: true, setupCompleted: true });
    expect(status).not.toHaveProperty("connectionSetup");
    await excel.execute({ operation: "read_range", address: "A1" });
    expect(nativeExcelControl.invoke).toHaveBeenCalledWith(expect.objectContaining({ kind: "read_range" }), undefined, { granted: false });
    expect(requestNativeAppAccess).not.toHaveBeenCalled();
  });

  it("reports that Excel is not open without asking or launching it", async () => {
    vi.mocked(nativeExcelControl.running).mockResolvedValue(false);
    const excel = tool();
    const status = await excel.execute({ operation: "status" });
    expect(status).toMatchObject({ enabled: false, note: expect.stringContaining("not open") });
    expect(status).not.toHaveProperty("connectionSetup");
    await expect(excel.execute({ operation: "selection" })).rejects.toThrow("not open");
    expect(requestNativeAppAccess).not.toHaveBeenCalled();
    expect(nativeExcelControl.invoke).not.toHaveBeenCalled();
  });

  it("asks once per message while Excel is open, and Allow once leaves the setting off", async () => {
    vi.mocked(requestNativeAppAccess).mockResolvedValue("allow-once");
    const excel = tool();
    const status = await excel.execute({ operation: "status" });
    expect(status).toMatchObject({ enabled: true, setupCompleted: false, workbooks: [{ id: "工作簿1" }] });
    expect(status).not.toHaveProperty("connectionSetup");
    await excel.execute({ operation: "selection" });
    expect(nativeExcelControl.invoke).toHaveBeenCalledWith(expect.objectContaining({ kind: "selection" }), undefined, { granted: true });
    expect(requestNativeAppAccess).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ displayName: "Microsoft Excel",
      appId: process.platform === "win32" ? "excel.exe" : "com.microsoft.Excel" }));
    expect(nativeExcelControl.authorizeOnce).toHaveBeenCalledOnce();
    expect(nativeExcelControl.setEnabled).not.toHaveBeenCalled();
    excel.setContext(new RequestContext({ ...scope, messageId: "second" }));
    await excel.execute({ operation: "status" });
    expect(requestNativeAppAccess).toHaveBeenCalledTimes(2);
  });

  it("turns the Computer Use setting on for Always allow", async () => {
    vi.mocked(requestNativeAppAccess).mockResolvedValue("allow-always");
    const excel = tool();
    await excel.execute({ operation: "read_range", address: "A1" });
    expect(nativeExcelControl.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(nativeExcelControl.invoke).toHaveBeenCalledWith(expect.objectContaining({ kind: "read_range" }), undefined, { granted: false });
    excel.setContext(new RequestContext({ ...scope, messageId: "second" }));
    await excel.execute({ operation: "status" });
    expect(requestNativeAppAccess).toHaveBeenCalledOnce();
  });

  it("does not ask again after a refusal in the same message, and lets the turn continue", async () => {
    vi.mocked(requestNativeAppAccess).mockResolvedValue("deny");
    const excel = tool();
    const stopTurn = vi.fn();
    const status = await excel.execute({ operation: "status" }, { stopTurn });
    expect(status).toMatchObject({ enabled: false, note: expect.stringContaining("not allowed") });
    expect(status).not.toHaveProperty("connectionSetup");
    await expect(excel.execute({ operation: "selection" }, { stopTurn })).rejects.toThrow("not allowed");
    await expect(excel.execute({ operation: "selection" }, { stopTurn })).rejects.not.toThrow(EXCEL_CONNECTION_SETTINGS_LINK);
    expect(requestNativeAppAccess).toHaveBeenCalledOnce();
    expect(nativeExcelControl.invoke).not.toHaveBeenCalled();
    expect(stopTurn).not.toHaveBeenCalled();
  });

  it("shares one prompt between parallel calls", async () => {
    let answer!: (decision: "allow-once") => void;
    vi.mocked(requestNativeAppAccess).mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const excel = tool();
    const both = Promise.all([excel.execute({ operation: "status" }), excel.execute({ operation: "selection" })]);
    await vi.waitFor(() => expect(requestNativeAppAccess).toHaveBeenCalledOnce());
    answer("allow-once");
    await both;
    expect(requestNativeAppAccess).toHaveBeenCalledOnce();
    expect(nativeExcelControl.authorizeOnce).toHaveBeenCalledOnce();
  });

  it("ends the turn when the operating system refuses Excel automation", async () => {
    vi.mocked(requestNativeAppAccess).mockResolvedValue("allow-once");
    vi.mocked(nativeExcelControl.authorizeOnce).mockRejectedValue(new Error("Automation denied (-1743). Allow Memmy to control Microsoft Excel"));
    const excel = tool();
    const stopTurn = vi.fn();
    await expect(excel.execute({ operation: "status" }, { stopTurn })).rejects.toThrow("-1743");
    expect(stopTurn).toHaveBeenCalledWith(expect.stringContaining(`[检查 Excel 连接授权](${EXCEL_CONNECTION_SETTINGS_LINK})`));
    await expect(excel.execute({ operation: "selection" }, { stopTurn })).rejects.toThrow("-1743");
    expect(nativeExcelControl.authorizeOnce).toHaveBeenCalledOnce();
    expect(stopTurn.mock.calls[1][0].split(EXCEL_CONNECTION_SETTINGS_LINK)).toHaveLength(2);
    expect(nativeExcelControl.invoke).not.toHaveBeenCalled();
  });

  it("includes a settings link and ends the turn for a cached operating-system permission failure", async () => {
    enabled = true;
    vi.mocked(nativeExcelControl.status).mockResolvedValue({ enabled: true, setupCompleted: true,
      connected: false, workbooks: [], permissionRequired: true,
      error: "Not authorized to send Apple events to Microsoft Excel" } as any);
    const stopTurn = vi.fn();
    const status = await tool().execute({ operation: "status" }, { stopTurn });
    expect(status).toMatchObject({ enabled: true, setupCompleted: true, connectionSetup: {
      settingsLink: EXCEL_CONNECTION_SETTINGS_LINK, reason: "permission-required", note: expect.any(String),
    } });
    expect(stopTurn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(EXCEL_CONNECTION_SETTINGS_LINK));
    expect(requestNativeAppAccess).not.toHaveBeenCalled();
    expect(nativeExcelControl.invoke).not.toHaveBeenCalled();
  });

  it.each(["deny", "closed"])("does not repeat setup guidance for %s even when an older system denial is cached", async state => {
    vi.mocked(requestNativeAppAccess).mockResolvedValue("deny");
    vi.mocked(nativeExcelControl.running).mockResolvedValue(state !== "closed");
    vi.mocked(nativeExcelControl.status).mockResolvedValue({ enabled: false, connected: false, workbooks: [],
      permissionRequired: true, error: "Automation denied (-1743)" } as any);
    const stopTurn = vi.fn();
    const status = await tool().execute({ operation: "status" }, { stopTurn });
    expect(status).not.toHaveProperty("connectionSetup");
    expect(stopTurn).not.toHaveBeenCalled();
    expect(nativeExcelControl.invoke).not.toHaveBeenCalled();
    expect(requestNativeAppAccess).toHaveBeenCalledTimes(state === "closed" ? 0 : 1);
  });

  it("does not mistake a cached system denial for a setup problem after an enabled Excel app closes", async () => {
    enabled = true;
    vi.mocked(nativeExcelControl.running).mockResolvedValue(false);
    vi.mocked(nativeExcelControl.status).mockResolvedValue({ enabled: true, setupCompleted: true, connected: false,
      workbooks: [], permissionRequired: true, error: "Automation denied (-1743)" } as any);
    const stopTurn = vi.fn();
    const status = await tool().execute({ operation: "status" }, { stopTurn });
    expect(status).toMatchObject({ enabled: true, note: expect.stringContaining("not open") });
    expect(status).not.toHaveProperty("connectionSetup");
    expect(stopTurn).not.toHaveBeenCalled();
    expect(nativeExcelControl.invoke).not.toHaveBeenCalled();
    expect(requestNativeAppAccess).not.toHaveBeenCalled();
  });

  it.each([null, "Microsoft Excel is not open", "Microsoft Excel is busy", "Excel operation timed out; result may be unknown"])(
    "does not suggest connection setup for an empty workbook list or unrelated error: %s", async error => {
      enabled = true;
      vi.mocked(nativeExcelControl.status).mockResolvedValue({ enabled: true, setupCompleted: true,
        connected: false, workbooks: [], activeWorkbookId: null, permissionRequired: false, error } as any);
      const stopTurn = vi.fn();
      const status = await tool().execute({ operation: "status" }, { stopTurn });
      expect(status).not.toHaveProperty("connectionSetup");
      expect(stopTurn).not.toHaveBeenCalled();
      expect(requestNativeAppAccess).not.toHaveBeenCalled();
    },
  );

  it("lets the turn continue after a write with an unknown result, so the model can read the range back", async () => {
    enabled = true;
    vi.mocked(nativeExcelControl.invoke).mockRejectedValueOnce(new Error("Excel operation timed out; result may be unknown and was not replayed"));
    const stopTurn = vi.fn();
    const excel = tool();
    await expect(excel.execute({ operation: "write_range", workbook: "工作簿1", address: "A1", values: [["=SUM(B1:B2)"]] }, { stopTurn })).rejects.toThrow("unknown");
    expect(stopTurn).not.toHaveBeenCalled();
    expect(nativeExcelControl.invoke).toHaveBeenCalledOnce();
    await excel.execute({ operation: "read_range", workbook: "工作簿1", address: "A1" }, { stopTurn });
    expect(nativeExcelControl.invoke).toHaveBeenLastCalledWith({ kind: "read_range", workbook: "工作簿1", address: "A1", sheet: undefined }, undefined, { granted: false });
    expect(vi.mocked(nativeExcelControl.invoke).mock.calls.filter(([action]) => action.kind === "write_range")).toHaveLength(1);
  });

  it("never asks outside an interactive user message", async () => {
    const excel = tool("first", { computerUseInteractive: false });
    expect(await excel.execute({ operation: "status" })).toMatchObject({ enabled: false, connectionSetup: {
      settingsLink: EXCEL_CONNECTION_SETTINGS_LINK, reason: "disabled", note: expect.any(String),
    } });
    await expect(excel.execute({ operation: "selection" })).rejects.toThrow(`[开启 Excel 连接](${EXCEL_CONNECTION_SETTINGS_LINK})`);
    expect(requestNativeAppAccess).not.toHaveBeenCalled();
    expect(nativeExcelControl.invoke).not.toHaveBeenCalled();
  });

  it("does not offer setup outside an interactive message when Excel is closed", async () => {
    vi.mocked(nativeExcelControl.running).mockResolvedValue(false);
    const status = await tool("first", { computerUseInteractive: false }).execute({ operation: "status" });
    expect(status).toMatchObject({ enabled: false, note: expect.stringContaining("not open") });
    expect(status).not.toHaveProperty("connectionSetup");
    expect(requestNativeAppAccess).not.toHaveBeenCalled();
  });

  it("keeps the original rejection and offers an enable link if access is switched off before dispatch", async () => {
    enabled = true;
    const failure = new Error("Enable Microsoft Excel in Memmy Computer Use settings first. This applies to every workbook.");
    vi.mocked(nativeExcelControl.invoke).mockRejectedValue(failure);
    const stopTurn = vi.fn();
    await expect(tool().execute({ operation: "selection" }, { stopTurn })).rejects.toBe(failure);
    expect(failure.message).toContain(`[开启 Excel 连接](${EXCEL_CONNECTION_SETTINGS_LINK})`);
    expect(nativeExcelControl.invoke).toHaveBeenCalledOnce();
    expect(stopTurn).not.toHaveBeenCalled();
  });
});
