/** Explicit user actions and cleanup share files across both runtimes. */
export type ConnectionKind = "skill" | "plugin";
export interface ConnectionEvent { id: string; state: "connected" | "disconnected"; kind?: ConnectionKind; revision?: number }
export interface ConnectionAction {
  readonly token: number;
  readonly sourceId: string;
  readonly state: "connected" | "disconnected";
  readonly kind: ConnectionKind;
  readonly done: Promise<void>;
  finish(): void;
  settled: boolean;
  successful: boolean;
  event?: ConnectionEvent;
  startedEvent?: ConnectionEvent;
  startedEventKnown: boolean;
}
export interface ConnectionBaseline { action?: ConnectionAction; settled: boolean; event?: ConnectionEvent }
export interface ConnectionDecision { key: string; kind?: ConnectionKind; event?: ConnectionEvent }

/** Different IDs alone do not order events, especially delayed HTTP replies. */
function isNewer(event: ConnectionEvent | undefined, before: ConnectionEvent | undefined): boolean {
  if (!event || event.id === before?.id) return false;
  if (!before) return true;
  if (event.revision === undefined) return false;
  return before.revision === undefined || event.revision > before.revision;
}

/** No lock spans user operations: a target may await a newer action reentrantly. */
export function createConnectionCompensation(readEvent: (sourceId: string) => Promise<ConnectionEvent | undefined>) {
  const actions = new Map<string, ConnectionAction>();
  const attempts = new Map<string, ConnectionBaseline>();
  const knownEvents = new Map<string, ConnectionEvent>();
  let sequence = 0;
  const observe = (sourceId: string, event: ConnectionEvent | undefined) => {
    const known = knownEvents.get(sourceId);
    if (event && (!known || isNewer(event, known))) knownEvents.set(sourceId, event);
    return knownEvents.get(sourceId);
  };
  const read = async (sourceId: string) => observe(sourceId, await readEvent(sourceId));
  const begin = async (sourceId: string, state: ConnectionAction["state"], kind: ConnectionKind): Promise<ConnectionAction> => {
    let finish!: () => void;
    const action: ConnectionAction = { sourceId, token: ++sequence, state, kind, settled: false, successful: false,
      startedEventKnown: false, done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
    actions.set(sourceId, action);
    try { action.startedEvent = await read(sourceId); action.startedEventKnown = true; }
    catch { /* An unavailable read supplies no new authorization. */ }
    return action;
  };
  const record = (action: ConnectionAction | undefined, event: ConnectionEvent | undefined) => {
    if (!action || !event) return;
    action.event = event;
    observe(action.sourceId, event);
  };
  const settle = (action: ConnectionAction | undefined, successful: boolean) => {
    if (!action) return;
    action.successful = successful;
    action.settled = true;
    action.finish();
  };
  const capture = async (sourceId: string): Promise<ConnectionBaseline> => {
    const action = actions.get(sourceId);
    const settled = action?.settled ?? true;
    const event = await read(sourceId);
    const baseline = { action, settled, event };
    attempts.set(sourceId, baseline);
    return baseline;
  };
  const desired = async (sourceId: string, baseline: ConnectionBaseline, ownAction?: ConnectionAction): Promise<ConnectionDecision> => {
    for (;;) {
      const action = actions.get(sourceId);
      if (action && action !== ownAction && !action.settled) { await action.done; continue; }
      // Unknown/failed/older reads never erase a committed event. Local notify
      // replies enter the same monotonic cache, before a later status save.
      try { await read(sourceId); } catch { /* Preserve the latest known authorization. */ }
      if (action !== actions.get(sourceId)) continue;
      const event = knownEvents.get(sourceId);
      const key = `${action?.token ?? 0}:${event?.id ?? ""}`;
      const newerAction = action && action !== ownAction && (action !== baseline.action || !baseline.settled);
      if (newerAction && !action.successful && action.state === "disconnected") {
        // The failed operation owns its own committed event, or its start
        // observation when it never committed. A later observation at failure
        // settlement must never swallow a newer remote reconnect.
        const boundary = action.event ?? action.startedEvent;
        if ((!action.event && !action.startedEventKnown) || !isNewer(event, boundary)) return { key };
      }
      if (isNewer(event, baseline.event)) {
        return { key, event, ...(event?.state === "connected" && event.kind ? { kind: event.kind } : {}) };
      }
      // Compatibility for an older authority without event metadata: only a
      // completed local explicit connection provides a new authorization.
      if (newerAction && action.successful && action.state === "connected" && !event && !action.event) return { key, kind: action.kind };
      return { key };
    }
  };
  return {
    begin, record, settle, capture,
    currentAction: (sourceId: string) => actions.get(sourceId),
    after: (action: ConnectionAction): ConnectionBaseline => ({ action, settled: false, event: action.event ?? action.startedEvent }),
    baseline: async (sourceId: string) => attempts.get(sourceId) ?? capture(sourceId),
    async compensate(sourceId: string, baseline: ConnectionBaseline, handlers: {
      remove: Array<() => Promise<void>>;
      install: (kind: ConnectionKind) => Promise<void>;
      commit: (decision: ConnectionDecision) => Promise<void>;
    }, ownAction?: ConnectionAction): Promise<void> {
      const latest = () => desired(sourceId, baseline, ownAction);
      let mayHaveRemovedFiles = false;
      for (;;) {
        const decision = await latest();
        if (decision.kind) {
          if (mayHaveRemovedFiles) {
            try { await handlers.install(decision.kind); }
            catch (error) {
              if ((await latest()).key === decision.key) throw error;
              continue;
            }
          }
        } else {
          let changed = false;
          for (const remove of handlers.remove) {
            if ((await latest()).key !== decision.key) { changed = true; break; }
            mayHaveRemovedFiles = true;
            try { await remove(); }
            catch (error) {
              if ((await latest()).key === decision.key) throw error;
              changed = true;
              break;
            }
          }
          if (changed) continue;
        }
        if ((await latest()).key !== decision.key) continue;
        try { await handlers.commit(decision); }
        catch (error) {
          // Stable failures remain errors; an obsolete save cannot end the
          // reconciliation of a newer committed explicit action.
          if ((await latest()).key === decision.key) throw error;
          continue;
        }
        if ((await latest()).key === decision.key) return;
      }
    }
  };
}
