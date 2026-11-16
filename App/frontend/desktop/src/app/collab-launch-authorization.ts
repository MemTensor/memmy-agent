/**
 * The authorization the collaboration announcement starts when its button opens the new-project dialog.
 *
 * It runs after the announcement is gone and nobody is supposed to watch it, so the state lives here instead of in a
 * component: a promise held by the card would either be dropped with it or keep a dead component alive. The board reads
 * the same state: while a request runs it must not ask for the same authorization again, and what did not finish is
 * reported there with a retry.
 */
import type { CollabClient } from "../api/collab-client.js";

export interface CollabLaunchAuthorizationFailure {
  /** How many agents are still missing. Null when this computer cannot say. */
  count: number | null;
  /** The agents a retry installs again. Empty when the whole request failed. */
  sourceIds: string[];
}

export interface CollabLaunchAuthorizationState {
  /** A request is running; the board treats the authorization as given meanwhile. */
  inFlight: boolean;
  /** The backend recorded the authorization, whatever the per-agent installs did. */
  granted: boolean;
  /** Agents that did not finish, waiting for a retry on the board. */
  failure: CollabLaunchAuthorizationFailure | null;
}

const EMPTY: CollabLaunchAuthorizationState = { inFlight: false, granted: false, failure: null };

let state: CollabLaunchAuthorizationState = EMPTY;
const listeners = new Set<() => void>();

function publish(next: CollabLaunchAuthorizationState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Subscribes the board to this state, the way `useSyncExternalStore` expects it. */
export function subscribeLaunchAuthorization(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current state; the same object until something changes, so React can compare it. */
export function getLaunchAuthorizationState(): CollabLaunchAuthorizationState {
  return state;
}

/** Whether a background authorization is running right now. */
export function isLaunchAuthorizationInFlight(): boolean {
  return state.inFlight;
}

/** Test-only: forgets the state so one test does not leak into the next. */
export function resetLaunchAuthorizationRuntime(): void {
  state = EMPTY;
}

/**
 * Starts the authorization in the background and returns at once: the announcement closes and the new-project dialog
 * opens without waiting for it, and nothing about the installs is shown on the way.
 */
export function startLaunchAuthorization(collab: CollabClient): void {
  if (state.inFlight) return;
  publish({ inFlight: true, granted: state.granted, failure: null });
  void run(collab, () => collab.setAgentAccess(true));
}

/**
 * Tries what did not finish: the failing agents alone when the authorization itself went through, the whole request
 * when it did not. Does nothing without a pending failure or while a request is already running.
 */
export function retryLaunchAuthorization(collab: CollabClient): void {
  const failure = state.failure;
  if (state.inFlight || failure === null) return;
  const sourceIds = failure.sourceIds;
  publish({ inFlight: true, granted: state.granted, failure: null });
  void run(collab, () => (sourceIds.length ? collab.installAgentAccess(sourceIds) : collab.setAgentAccess(true)));
}

async function run(
  collab: CollabClient,
  request: () => Promise<{ view: { granted: boolean }; results: { sourceId: string; ok: boolean }[] }>
): Promise<void> {
  try {
    const result = await request();
    const failed = result.results.filter((item) => !item.ok);
    publish({
      inFlight: false,
      granted: result.view.granted,
      failure: failed.length
        ? { count: failed.length, sourceIds: failed.map((item) => item.sourceId) }
        : null
    });
  } catch {
    publish({ inFlight: false, granted: false, failure: { count: await pendingAgentCount(collab), sourceIds: [] } });
  }
}

/** How many agents on this computer still have nothing installed, for the wording of a failed request. */
async function pendingAgentCount(collab: CollabClient): Promise<number | null> {
  try {
    const view = await collab.getAgentAccess();
    const pending = view.agents.filter((agent) => agent.available && agent.enabled && !agent.installed).length;
    return pending > 0 ? pending : null;
  } catch {
    return null;
  }
}
