import { z } from "zod";
import { RecordingSessionSchema, RecordingEventSchema, RecordingExportResultSchema, RecordingConfigurationSchema,
  type RecordingStart, type RecordingSession, type RecordingPermission } from "@memmy/local-api-contracts";
type Request = <T>(path: string, schema: z.ZodType<T>, options?: { method?: string; body?: unknown }) => Promise<T>;
const done = z.object({ deleted: z.boolean() });
export class ComputerRecordingsClient {
  constructor(private readonly request: Request) {}
  configuration() { return this.request("/api/computer-recordings/configuration", RecordingConfigurationSchema); }
  openPermission(permission: RecordingPermission, mode: "request" | "settings") {
    return this.request("/api/computer-recordings/permissions/open", RecordingConfigurationSchema, { method: "POST", body: { permission, mode } });
  }
  list(chatId?: string) { return this.request(`/api/computer-recordings${chatId ? `?chat_id=${encodeURIComponent(chatId)}` : ""}`, z.object({ recordings: z.array(RecordingSessionSchema) })); }
  get(id: string) { return this.request(`/api/computer-recordings/${encodeURIComponent(id)}`, RecordingSessionSchema); }
  start(input: RecordingStart) { return this.request("/api/computer-recordings/start", RecordingSessionSchema, { method: "POST", body: input }); }
  control(id: string, action: "pause" | "resume" | "stop") { return this.request(`/api/computer-recordings/${encodeURIComponent(id)}/${action}`, RecordingSessionSchema, { method: "POST", body: {} }); }
  events(id: string, after = 0) { return this.request(`/api/computer-recordings/${encodeURIComponent(id)}/events?after=${after}`, z.object({ events: z.array(RecordingEventSchema), nextCursor: z.number().nullable() })); }
  pin(id: string, pinned: boolean) { return this.request(`/api/computer-recordings/${encodeURIComponent(id)}`, RecordingSessionSchema, { method: "PATCH", body: { pinned } }); }
  delete(id: string) { return this.request(`/api/computer-recordings/${encodeURIComponent(id)}`, done, { method: "DELETE" }); }
  clear(scope: "today" | "all") { return this.request("/api/computer-recordings/clear", z.object({ cleared: z.boolean() }), { method: "POST", body: { scope } }); }
  export(id: string) { return this.request(`/api/computer-recordings/${encodeURIComponent(id)}/export-openadapt`, RecordingExportResultSchema, { method: "POST", body: {} }); }
  exportStatus(id: string, exportId: string) { return this.request(`/api/computer-recordings/${encodeURIComponent(id)}/exports/${encodeURIComponent(exportId)}`, RecordingExportResultSchema); }
  mediaUrl(session: Pick<RecordingSession, "id">, mediaId = "recording", download = false): string {
    return `memmy-recording://recording/${encodeURIComponent(session.id)}/video?media=${encodeURIComponent(mediaId)}${download ? "&download=1" : ""}`;
  }
}
