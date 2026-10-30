import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { EventCaptureSubscription, CaptureCheckpoint, CaptureRange } from "./core/event-capture-source.js";
import { DEFAULT_OBSERVATION_SETTINGS, evaluateObservation, parseObservationSettings } from "./core/observation-settings.js";
import { defaultSettingsFile } from "./core/settings-store.js";
import { redactSensitive } from "./core/redaction.js";
import { sanitizeBrowserUrl } from "./browser-privacy.js";
import { parseWindowsSettings } from "./win/settings.js";

export const BrowserCaptureRequestSchema = z.object({ name: z.enum(["chrome", "edge"]),
  connection_id: z.string().min(1).max(100).optional() }).strict();
export type BrowserCaptureRequest = z.infer<typeof BrowserCaptureRequestSchema>;
export interface BrowserCaptureTransport {
  listTeachingProfiles(): Array<{ connectionId: string; browser: "chrome" | "edge"; supported: boolean;
    windows: Array<{ tabId: number; title: string; url: string }> }>;
  subscribeTeaching(connectionId: string, sessionId: string, listener: (message: Record<string, unknown>) => void): () => void;
  teachingCommand(connectionId: string, sessionId: string, action: "prepare" | "start" | "checkpoint" | "stop" | "cancel",
    input?: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export interface BrowserCaptureProvider {
  profiles(): unknown;
  acquire(input: { sessionId: string; directory: string; request: BrowserCaptureRequest; signal: AbortSignal }):
    Promise<EventCaptureSubscription & { browserCapture: { browser: "chrome" | "edge"; windowId: number; scope: "teaching-window-and-popups" } }>;
}
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const types = new Set(["click", "text_input", "submit", "navigation", "key_press", "selection_changed"]);
const codePattern = /^[a-z][a-z0-9_]{0,79}$/;

/** A private source per Teach fragment. No desktop/history source is acquired or scanned. */
export function createBrowserCaptureProvider(transport: BrowserCaptureTransport,
  options: { settingsFile?: string; windowsSettingsFile?: string; platform?: NodeJS.Platform; now?: () => number;
    launch?: (browser: "chrome" | "edge") => Promise<void> } = {}): BrowserCaptureProvider {
  const now = () => options.now?.() ?? Date.now();
  function settings(browser?: "chrome" | "edge") {
    const file = options.settingsFile ?? defaultSettingsFile();
    // A new browser-only installation need not enable background History. A corrupt existing policy fails closed.
    const value = fs.existsSync(file) ? parseObservationSettings(JSON.parse(fs.readFileSync(file, "utf8"))) : structuredClone(DEFAULT_OBSERVATION_SETTINGS);
    const windowsFile = options.windowsSettingsFile ?? path.join(path.dirname(file), "windows-settings.json");
    if (browser && (options.platform ?? process.platform) === "win32" && fs.existsSync(windowsFile)) {
      const windows = parseWindowsSettings(JSON.parse(fs.readFileSync(windowsFile, "utf8")));
      const basename = browser === "chrome" ? "chrome.exe" : "msedge.exe";
      const matches = (executable: string) => path.win32.basename(executable).toLowerCase() === basename;
      if (windows.deny?.executables?.some(matches) || (windows.defaultApplicationBehavior !== "observe"
        && !windows.applications.some(rule => matches(rule.executable)))) {
        value.observation.rules.push({ scope: "app", bundleID: bundle(browser), behavior: "do_not_observe" });
      }
    }
    return value;
  }
  const bundle = (name: "chrome" | "edge") => (options.platform ?? process.platform) === "darwin"
    ? name === "chrome" ? "com.google.chrome" : "com.microsoft.edgemac" : name === "chrome" ? "win32.chrome" : "win32.msedge";
  return {
    profiles: () => ({ profiles: transport.listTeachingProfiles(), setup: "memmy://settings/browser-extension",
      scope: "New teaching window and browser-proven popups only; everyday windows are excluded." }),
    async acquire({ sessionId, directory, request, signal }) {
      let candidates = transport.listTeachingProfiles().filter(profile => profile.browser === request.name);
      if (!candidates.length && options.launch) {
        signal.throwIfAborted(); await options.launch(request.name);
        const deadline = Date.now() + 10_000;
        while (!candidates.length && Date.now() < deadline) {
          signal.throwIfAborted();
          await new Promise(resolve => setTimeout(resolve, 200));
          candidates = transport.listTeachingProfiles().filter(profile => profile.browser === request.name);
        }
        signal.throwIfAborted();
      }
      const profile = request.connection_id ? candidates.find(candidate => candidate.connectionId === request.connection_id)
        : candidates.length === 1 ? candidates[0] : undefined;
      if (!profile) throw new Error(candidates.length > 1 ? "browser_capture_profile_selection_required: use browser-options and select a connection_id in this conversation"
        : "browser_capture_extension_required: memmy://settings/browser-extension");
      if (!profile.supported) throw new Error("browser_capture_extension_outdated: reload the Memmy extension at memmy://settings/browser-extension");
      const policy = settings(request.name), appId = bundle(request.name);
      // There is no page URL before the teaching window is created. Only reject
      // application exclusions here; each page event still uses the full policy below.
      const applicationDecision = evaluateObservation(policy, { bundleId: appId });
      if (!applicationDecision.observe && applicationDecision.reason !== "url_not_allowed") {
        throw new Error("browser_capture_application_excluded");
      }
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, "browser-source.jsonl"), fd = fs.openSync(file, "wx", 0o600);
      const proofFile = path.join(directory, "capture-proof.jsonl");
      let proofFd: number;
      try { proofFd = fs.openSync(proofFile, "wx", 0o600); } catch (error) { fs.closeSync(fd); throw error; }
      const windows = new Set<number>(), tabs = new Map<number, number>();
      type Document = { tabId: number; windowId: number; urls: Set<string>; sequence: number; closed: boolean; retiredAt?: number };
      const documents = new Map<string, Document>(), issues = new Set<string>();
      let sequence = 0, bytes = 0, proofBytes = 0, running = true, released = false, prepared = false, started = false, sealed = false;
      let boundary = 0, boundaryConfirmed = true, coverageComplete = true, proofSha256: string | null = null;
      let stopPoint: CaptureCheckpoint | undefined, cutoff: number | undefined;
      const recordProof = (value: Record<string, unknown>) => {
        const line = Buffer.from(JSON.stringify({ at: new Date(now()).toISOString(), ...value }) + "\n");
        if (proofBytes + line.length > 16 * 1024 * 1024) throw Error("browser_capture_proof_limit");
        let written = 0;
        while (written < line.length) { const count = fs.writeSync(proofFd, line, written, line.length - written); if (!count) throw Error("browser_capture_proof_write_failed"); written += count; }
        proofBytes += line.length;
      };
      const fault = (code: string) => {
        if (!issues.has(code)) {
          issues.add(code);
          try { recordProof({ kind: "fault", code, sequence }); } catch { running = false; issues.add("browser_capture_proof_write_failed"); }
        }
        coverageComplete = false;
      };
      const early: Record<string, unknown>[] = [];
      const receive = (message: Record<string, unknown>) => {
        if (released || sealed) return;
        if (message.kind === "disconnected") { running = false; fault("browser_capture_disconnected"); return; }
        if (!prepared) { if (early.length < 128) early.push(message); else { running = false; fault("browser_capture_preparation_overflow"); } return; }
        if (!integer(message.sequence) || message.sequence !== sequence + 1) { fault("browser_capture_sequence_gap"); running = false; return; }
        sequence = message.sequence;
        if (message.kind === "fault") {
          fault(typeof message.code === "string" && codePattern.test(message.code) ? message.code : "browser_capture_fault");
          if (message.terminal === true) running = false;
          return;
        }
        if (message.kind === "window") {
          if (!integer(message.windowId) || !integer(message.sourceTabId) || !integer(message.sourceWindowId)
            || tabs.get(message.sourceTabId) !== message.sourceWindowId || !windows.has(message.sourceWindowId)
            || windows.has(message.windowId)) { fault("browser_capture_invalid_window"); return; }
          windows.add(message.windowId); return;
        }
        if (message.kind === "tab-left") {
          if (integer(message.tabId)) {
            tabs.delete(message.tabId);
            for (const doc of documents.values()) if (doc.tabId === message.tabId && !doc.closed) {
              doc.closed = true; fault("browser_capture_document_tail_unconfirmed");
            }
          }
          return;
        }
        if (message.kind === "proof") {
          const proof: Record<string, unknown> = { kind: "document-proof", sequence };
          for (const key of ["status", "checkpointId", "documentId", "errorCode"]) {
            const value = message[key];
            if (typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value)) proof[key] = value;
          }
          for (const key of ["tabId", "contextId", "epoch", "documentSequence", "finalSequence", "elapsedMs"]) if (integer(message[key])) proof[key] = message[key];
          try { recordProof(proof); } catch { running = false; fault("browser_capture_proof_write_failed"); }
          return;
        }
        if (message.kind === "document-closed") {
          const doc = typeof message.documentId === "string" ? documents.get(message.documentId) : undefined;
          if (!doc || doc.tabId !== message.tabId || message.documentSequence !== doc.sequence || message.confirmed !== true) fault("browser_capture_document_sequence_gap");
          if (doc) { doc.closed = true; doc.retiredAt = now(); }
          try { recordProof({ kind: "document-closed", documentId: typeof message.documentId === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(message.documentId) ? message.documentId : "unknown", sequence,
            documentSequence: integer(message.documentSequence) ? message.documentSequence : null, confirmed: message.confirmed === true }); } catch { running = false; fault("browser_capture_proof_write_failed"); }
          return;
        }
        if (message.kind === "document") {
          const blank = message.url === "about:blank";
          if (!integer(message.windowId) || !windows.has(message.windowId) || !integer(message.tabId)
            || typeof message.documentId !== "string" || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(message.documentId)
            || message.incognito !== false || typeof message.url !== "string" || message.url.length > 4096 || (!blank && !sanitizeBrowserUrl(message.url))) {
            fault("browser_capture_invalid_document"); return;
          }
          for (const [id, old] of documents) {
            if (old.tabId === message.tabId && id !== message.documentId && old.retiredAt === undefined) old.retiredAt = now();
            if (old.closed && old.retiredAt !== undefined && now() - old.retiredAt > 10_000) documents.delete(id);
          }
          const old = documents.get(message.documentId);
          if (old && (old.closed || old.tabId !== message.tabId || old.windowId !== message.windowId)) { fault("browser_capture_invalid_document"); return; }
          if (!old && documents.size >= 4096) { fault("browser_capture_document_limit"); running = false; return; }
          tabs.set(message.tabId, message.windowId);
          const doc = old ?? { tabId: message.tabId, windowId: message.windowId, urls: new Set<string>(), sequence: 0, closed: false };
          doc.urls.add(blank ? "about:blank" : sanitizeBrowserUrl(message.url));
          documents.set(message.documentId, doc);
          try { recordProof({ kind: "document", documentId: message.documentId, tabId: message.tabId, sequence }); }
          catch { running = false; fault("browser_capture_proof_write_failed"); }
          return;
        }
        if (message.kind !== "event" || !started || !running) return;
        const doc = typeof message.documentId === "string" ? documents.get(message.documentId) : undefined;
        if (!integer(message.tabId) || tabs.get(message.tabId) !== message.windowId || !windows.has(message.windowId as number)
          || !doc || doc.closed || doc.tabId !== message.tabId || doc.windowId !== message.windowId
          || (doc.retiredAt !== undefined && now() - doc.retiredAt > 5000) || !types.has(String(message.eventType))) {
          fault("browser_capture_out_of_scope"); return;
        }
        if (message.eventType !== "navigation") {
          if (!integer(message.documentSequence) || message.documentSequence !== doc.sequence + 1) { fault("browser_capture_document_sequence_gap"); return; }
          doc.sequence = message.documentSequence;
        }
        const url = typeof message.url === "string" && message.url.length <= 4096 ? sanitizeBrowserUrl(message.url) : "";
        if (!url || !doc.urls.has(url)) { fault("browser_capture_invalid_url"); return; }
        try {
          if (!evaluateObservation(settings(request.name), { bundleId: appId, browser: true, url, privateBrowsing: false }).observe) {
            fault("browser_capture_site_excluded"); return;
          }
          if (!integer(message.observedAt) || message.observedAt > now() + 1_000 || now() - message.observedAt > 30_000) {
            fault("browser_capture_stale_event"); return;
          }
          if (cutoff !== undefined && message.observedAt > cutoff) return;
          const raw = message.details;
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) { fault("browser_capture_invalid_event"); return; }
          const details: Record<string, unknown> = {};
          // Deliberately narrow: no arbitrary page object or extension payload reaches disk.
          for (const key of ["role", "label", "selector", "inputType", "text", "textSource", "key", "frameUrl"]) {
            const value = (raw as Record<string, unknown>)[key];
            if (typeof value === "string") details[key] = redactSensitive(value.slice(0, key === "text" ? 1_000 : 320));
          }
          details.redacted = (raw as Record<string, unknown>).redacted === true;
          if (/password|hidden|file|one.?time|otp|cvc|cvv|secret|token|密码|验证码|密钥/i.test(String(details.inputType ?? "") + " " + String(details.label ?? ""))) {
            delete details.text; details.redacted = true;
          }
          const event = { recordType: "human_event", sequence, eventType: message.eventType,
            timestamp: new Date(message.observedAt).toISOString(),
            application: { name: request.name === "chrome" ? "Google Chrome" : "Microsoft Edge", bundleId: appId },
            window: { browser: true, url: redactSensitive(url), windowId: String(message.windowId) },
            details: { ...details, browserCapture: { sessionId, tabId: message.tabId, documentId: message.documentId,
              documentSequence: doc.sequence, origin: "extension", scope: "teaching-window-and-popups" } } };
          const line = Buffer.from(JSON.stringify(event) + "\n");
          if (bytes + line.length > 64 * 1024 * 1024) throw new Error("browser_capture_evidence_limit");
          let written = 0;
          while (written < line.length) { const count = fs.writeSync(fd, line, written, line.length - written); if (!count) throw new Error("browser_capture_write_failed"); written += count; }
          bytes += line.length;
        } catch { fault("browser_capture_policy_or_write_failed"); running = false; }
      };
      const off = transport.subscribeTeaching(profile.connectionId, sessionId, receive);
      const command = (action: "prepare" | "start" | "checkpoint" | "stop" | "cancel", input: Record<string, unknown> = {}) =>
        transport.teachingCommand(profile.connectionId, sessionId, action, input);
      const abort = () => { running = false; void command("cancel").catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      const point = (): CaptureCheckpoint => ({ running, complete: coverageComplete && boundaryConfirmed, rangeEvaluated: true, boundaryConfirmed,
        captureIntegrity: { protocolVersion: 2, coverageComplete, boundaryConfirmed, snapshotSaved: false, proofSha256, gaps: [...issues] },
        streams: [{ id: `browser:${sessionId}`, file, size: boundary }], limitations: [
          "Only this teaching window and browser-proven popups; everyday browser windows are excluded.",
          "Passwords/OTP/payment fields, values entered outside recording, and edits without inserted text are omitted or redacted.",
          "Browser menus, OS dialogs, cross-origin frames and canvas actions are not covered by this browser source.", ...issues] });
      try {
        signal.throwIfAborted();
        const result = await command("prepare", { protocolVersion: 2, settings: policy, bundleId: appId });
        signal.throwIfAborted();
        if (result.protocolVersion !== 2 || !integer(result.windowId) || result.incognito !== false) throw new Error("browser_capture_window_binding_failed");
        windows.add(result.windowId);
        prepared = true; early.splice(0).forEach(receive);
        // The initial baseline precedes start: no user event can slip into an unbound source.
        return {
          browserCapture: { browser: request.name, windowId: result.windowId, scope: "teaching-window-and-popups" },
          async checkpoint(range?: CaptureRange) {
            if (stopPoint) return stopPoint;
            if (!started) {
              signal.throwIfAborted();
              const ack = await command("start");
              if (ack.protocolVersion !== 2 || ack.recording !== true) throw new Error("browser_capture_not_ready");
              started = true;
            } else if (running) {
              try {
                if (range?.through) cutoff ??= Date.parse(range.through);
                const ack = await command(range?.through ? "stop" : "checkpoint", { protocolVersion: 2, settings: settings(request.name), ...(range?.through ? { through: new Date(cutoff!).toISOString(), stopId: sessionId } : {}) });
                if (ack.protocolVersion !== 2 || typeof ack.boundaryConfirmed !== "boolean" || typeof ack.coverageComplete !== "boolean" || !integer(ack.lastSequence)) throw Error("browser_capture_invalid_ack");
                boundaryConfirmed = ack.boundaryConfirmed && ack.lastSequence === sequence;
                if (!ack.coverageComplete) fault("browser_capture_coverage_incomplete");
                if (!boundaryConfirmed) fault("browser_capture_boundary_unconfirmed");
                recordProof({ kind: "checkpoint", final: !!range?.through, lastSequence: ack.lastSequence,
                  receivedSequence: sequence, boundaryConfirmed, coverageComplete });
              } catch {
                boundaryConfirmed = false; fault("browser_capture_boundary_unconfirmed");
                if (range?.through) void command("cancel").catch(() => undefined);
              }
            } else { boundaryConfirmed = false; fault("browser_capture_boundary_unconfirmed"); }
            fs.fsyncSync(fd); fs.fsyncSync(proofFd); boundary = bytes;
            if (range?.through) {
              sealed = true;
              proofSha256 = createHash("sha256").update(fs.readFileSync(proofFile)).digest("hex");
            }
            const result = point();
            if (range?.through) stopPoint = result;
            return result;
          },
          async release() {
            if (released) return;
            released = true; signal.removeEventListener("abort", abort); off();
            try { if (prepared) await command("cancel").catch(() => undefined); }
            finally { fs.closeSync(fd); fs.closeSync(proofFd); }
          },
        };
      } catch (error) {
        // prepare may have created a window before its acknowledgement timed out.
        await command("cancel").catch(() => undefined); released = true; off(); signal.removeEventListener("abort", abort); fs.closeSync(fd); fs.closeSync(proofFd); throw error;
      }
    },
  };
}
