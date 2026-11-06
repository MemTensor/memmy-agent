import fs from "node:fs";
import { RecordingStartSchema } from "@memmy/local-api-contracts";
import { RecordingError, type RecordingSessionService } from "./session-service.js";

export interface RecordingHttpResponse { status: number; headers: Record<string, string>; body: Buffer | string; stream?: fs.ReadStream }
const json = (value: unknown, status = 200): RecordingHttpResponse => ({ status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
export function recordingRange(value: string | undefined, size: number): { start: number; end: number; partial: boolean } {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) throw new RecordingError(416, "recording_range_invalid");
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start < 0 || end < start || (!match[1] && Number(match[2]) <= 0)) throw new RecordingError(416, "recording_range_invalid");
  return { start, end, partial: true };
}
export async function handleRecordingHttp(service: RecordingSessionService,
  request: { path?: string; method?: string; headers?: Record<string, unknown>; body?: string | Buffer }, authorized: boolean): Promise<RecordingHttpResponse> {
  if (!authorized) return json({ error: "Unauthorized" }, 401);
  const url = new URL(request.path ?? "/", "http://127.0.0.1");
  const relative = url.pathname.slice("/api/computer-recordings".length).replace(/\/$/u, "");
  const method = (request.method ?? "GET").toUpperCase();
  let body: Record<string, unknown> = {};
  try {
    if (request.body?.length) {
      if (Buffer.byteLength(request.body) > 64 * 1024) throw new RecordingError(413, "recording_request_too_large");
      body = JSON.parse(request.body.toString());
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new RecordingError(400, "body_must_be_object");
    }
    if (!relative && method === "GET") return json({ recordings: await service.list(url.searchParams.get("chat_id") ?? undefined) });
    if (relative === "/configuration" && method === "GET") return json(await service.configuration());
    if (relative === "/permissions/open" && method === "POST") {
      if (!["accessibility", "inputMonitoring", "screenRecording"].includes(String(body.permission))
        || (body.mode !== "request" && body.mode !== "settings") || Object.keys(body).some((key) => !["permission", "mode"].includes(key))) throw new RecordingError(422, "recording_permission_invalid");
      return json(await service.openPermission(body.permission as "accessibility" | "inputMonitoring" | "screenRecording", body.mode));
    }
    if (relative === "/start" && method === "POST") {
      const parsed = RecordingStartSchema.safeParse(body);
      if (!parsed.success) throw new RecordingError(422, "recording_requires_applications_and_video_consent");
      return json(await service.start(parsed.data), 201);
    }
    if (relative === "/active/stop" && method === "POST") {
      const active = (await service.list()).find((session) => !["ready", "failed"].includes(session.state));
      if (active) await service.control(active.id, "stop", "app_exit");
      return json({ stopped: true });
    }
    if (relative === "/clear" && method === "POST") {
      if (body.scope !== "all" && body.scope !== "today") throw new RecordingError(422, "recording_clear_scope_invalid");
      await service.clear(body.scope); return json({ cleared: true });
    }
    const match = /^\/([^/]+)(?:\/(pause|resume|stop|events|video|export-openadapt|exports)(?:\/([^/]+))?)?$/u.exec(relative);
    if (!match) throw new RecordingError(404, "recording_route_not_found");
    const id = match[1]!, action = match[2], exportId = match[3];
    if (!action && method === "GET") return json(await service.get(id));
    if (!action && method === "PATCH") {
      if (typeof body.pinned !== "boolean" || Object.keys(body).length !== 1) throw new RecordingError(422, "recording_patch_invalid");
      return json(await service.pin(id, body.pinned));
    }
    if (!action && method === "DELETE") { await service.delete(id); return json({ deleted: true }); }
    if (["pause", "resume", "stop"].includes(action ?? "") && method === "POST") return json(await service.control(id, action as "pause" | "resume" | "stop"));
    if (action === "events" && method === "GET") return json(await service.events(id, Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("limit") ?? 500)));
    if (action === "export-openadapt" && method === "POST") return json(await service.exportOpenAdapt(id), 202);
    if (action === "exports" && method === "GET" && exportId) return json(await service.getExport(id, exportId));
    if (action === "video" && (method === "GET" || method === "HEAD")) {
      const media = await service.openMedia(id, url.searchParams.get("media") ?? "recording");
      let range;
      try { range = recordingRange(typeof request.headers?.range === "string" ? request.headers.range : undefined, media.size); }
      catch { fs.closeSync(media.fd); return { ...json({ error: "recording_range_invalid" }, 416), headers: { "content-range": `bytes */${media.size}`, "accept-ranges": "bytes" } }; }
      const headers: Record<string, string> = { "content-type": media.type, "accept-ranges": "bytes", "content-length": String(range.end - range.start + 1),
        "cache-control": "no-store", "x-content-type-options": "nosniff" };
      if (range.partial) headers["content-range"] = `bytes ${range.start}-${range.end}/${media.size}`;
      if (url.searchParams.get("download") === "1") headers["content-disposition"] = `attachment; filename="${id}.${media.type === "video/mp4" ? "mp4" : "zip"}"`;
      if (method === "HEAD") { fs.closeSync(media.fd); return { status: range.partial ? 206 : 200, headers, body: "" }; }
      return { status: range.partial ? 206 : 200, headers, body: "", stream: fs.createReadStream("", { fd: media.fd, start: range.start, end: range.end, autoClose: true }) };
    }
    throw new RecordingError(405, "method_not_allowed");
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : error instanceof SyntaxError ? 400 : 500;
    return json({ error: status < 500 && error instanceof Error ? error.message : "recording_operation_failed" }, status);
  }
}
