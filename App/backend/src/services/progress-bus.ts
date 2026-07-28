/** Progress bus module. */
import { EventEmitter } from "node:events";
import type { ScanPhase, ScanResult } from "@memmy/local-api-contracts";

/** Contract for agent source scan progress event. */
export interface AgentSourceScanProgressEvent {
  jobId: string;
  sourceId: string;
  phase: ScanPhase;
  current: number;
  total: number;
  message?: string;
}

/** Contract for agent source scan completed event. */
export interface AgentSourceScanCompletedEvent {
  jobId: string;
  sourceId: string;
  results: ScanResult[];
}

/** Contract for progress bus event map. */
export interface ProgressBusEventMap {
  "agent_source.scan_progress": AgentSourceScanProgressEvent;
  "agent_source.scan_completed": AgentSourceScanCompletedEvent;
}

/** Contract for progress bus. */
export interface ProgressBus {
  emit<EventName extends keyof ProgressBusEventMap>(
    eventName: EventName,
    event: ProgressBusEventMap[EventName]
  ): void;
  on<EventName extends keyof ProgressBusEventMap>(
    eventName: EventName,
    listener: (event: ProgressBusEventMap[EventName]) => void
  ): () => void;
}

/** Creates create progress bus. */
export function createProgressBus(): ProgressBus {
  const emitter = new EventEmitter();

  return {
    emit(eventName, event) {
      emitter.emit(eventName, event);
    },

    on(eventName, listener) {
      emitter.on(eventName, listener);
      return () => {
        emitter.off(eventName, listener);
      };
    }
  };
}
