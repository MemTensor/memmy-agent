import type { CaptureIntegrity } from "@memmy/local-api-contracts";
/** The recorder remains owned by Computer History; consumers own subscriptions. */
export interface CaptureRange { from: string; through?: string }
export interface CaptureCheckpoint {
  streams: Array<{ id: string; file: string; size: number }>;
  running: boolean;
  /** A confirmed durable boundary with no known coverage gaps in the requested interval. */
  complete?: boolean;
  /** Completeness was evaluated for the requested interval, not the process lifetime. */
  rangeEvaluated?: boolean;
  /** The ordered boundary reached durable storage, independently of interval health. */
  boundaryConfirmed?: boolean;
  captureIntegrity?: CaptureIntegrity;
  limitations: string[];
}
export interface EventCaptureSubscription {
  checkpoint(range?: CaptureRange): Promise<CaptureCheckpoint>;
  release(): Promise<void>;
}
export interface EventCaptureSource {
  acquireEventCapture(): Promise<EventCaptureSubscription>;
}
