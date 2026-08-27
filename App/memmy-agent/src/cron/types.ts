export type CronScheduleKind = "at" | "every" | "cron";
export type CronPayloadKind = "systemEvent" | "agentTurn" | string;
export type CronRunStatus = "ok" | "error" | "skipped";

export class CronSchedule {
  kind: CronScheduleKind;
  atMs: number | null;
  at?: string | null;
  everyMs: number | null;
  expr: string | null;
  tz: string | null;

  constructor(init: {
    kind?: CronScheduleKind;
    atMs?: number | null;
    at?: string | null;
    everyMs?: number | null;
    expr?: string | null;
    tz?: string | null;
  } = {}) {
    this.kind = init.kind ?? "every";
    this.atMs = init.atMs ?? null;
    this.at = init.at ?? null;
    this.everyMs = init.everyMs ?? null;
    this.expr = init.expr ?? null;
    this.tz = init.tz ?? null;
  }

  static fromObject(data: any): CronSchedule {
    return new CronSchedule(data ?? {});
  }

  toObject(): Record<string, any> {
    const out: Record<string, any> = { kind: this.kind };
    if (this.atMs != null) out.atMs = this.atMs;
    if (this.at != null) out.at = this.at;
    if (this.everyMs != null) out.everyMs = this.everyMs;
    if (this.expr != null) out.expr = this.expr;
    if (this.tz != null) out.tz = this.tz;
    return out;
  }
}

export class CronPayload {
  kind: CronPayloadKind;
  message: string;
  prompt: string;
  deliver: boolean;
  channel: string | null;
  to: string | null;
  chatId: string | null;
  channelMeta: Record<string, any>;
  sessionKey: string | null;
  metadata: Record<string, any>;

  constructor(init: Partial<CronPayload> & { prompt?: string; message?: string; kind?: CronPayloadKind } = {}) {
    this.kind = init.kind ?? "agentTurn";
    this.message = init.message ?? init.prompt ?? "";
    this.prompt = init.prompt ?? init.message ?? "";
    this.deliver = init.deliver ?? false;
    this.channel = init.channel ?? null;
    this.to = init.to ?? null;
    this.chatId = init.chatId ?? this.to;
    this.channelMeta = init.channelMeta ?? {};
    this.sessionKey = init.sessionKey ?? null;
    this.metadata = init.metadata ?? {};
  }

  toObject(): Record<string, any> {
    return {
      kind: this.kind,
      message: this.message,
      prompt: this.prompt,
      deliver: this.deliver,
      channel: this.channel,
      to: this.to,
      chatId: this.chatId,
      channelMeta: this.channelMeta,
      sessionKey: this.sessionKey,
      metadata: this.metadata,
    };
  }
}

export class CronRunRecord {
  runAtMs: number;
  durationMs: number;
  status: CronRunStatus;
  error: string | null;

  constructor(init: {
    runAtMs?: number;
    durationMs?: number;
    status?: CronRunStatus;
    error?: string | null;
  } = {}) {
    this.runAtMs = init.runAtMs ?? Date.now();
    this.durationMs = init.durationMs ?? 0;
    this.status = init.status ?? "ok";
    this.error = init.error ?? null;
  }

  toObject(): Record<string, any> {
    return {
      runAtMs: this.runAtMs,
      status: this.status,
      durationMs: this.durationMs,
      error: this.error,
    };
  }
}

export class CronJobState {
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: CronRunStatus | null;
  lastError: string | null;
  runHistory: CronRunRecord[];

  constructor(init: Partial<CronJobState> = {}) {
    this.nextRunAtMs = init.nextRunAtMs ?? null;
    this.lastRunAtMs = init.lastRunAtMs ?? null;
    this.lastStatus = init.lastStatus ?? null;
    this.lastError = init.lastError ?? null;
    const history = init.runHistory ?? [];
    this.runHistory = history.map((row: any) =>
      row instanceof CronRunRecord ? row : new CronRunRecord(row),
    );
  }

  toObject(): Record<string, any> {
    return {
      nextRunAtMs: this.nextRunAtMs,
      lastRunAtMs: this.lastRunAtMs,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
      runHistory: this.runHistory.map((row) => row.toObject()),
    };
  }
}

export class CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  state: CronJobState;
  system: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  deleteAfterRun: boolean;

  constructor(init: {
    id: string;
    schedule?: CronSchedule | ConstructorParameters<typeof CronSchedule>[0];
    payload?: CronPayload | ConstructorParameters<typeof CronPayload>[0];
    name?: string | null;
    enabled?: boolean;
    state?: CronJobState | Partial<CronJobState> | string;
    system?: boolean;
    createdAtMs?: number;
    updatedAtMs?: number;
    deleteAfterRun?: boolean;
  }) {
    this.id = init.id;
    this.name = init.name ?? "";
    this.enabled = init.enabled ?? true;
    this.schedule = init.schedule instanceof CronSchedule ? init.schedule : new CronSchedule(init.schedule ?? {});
    this.payload = init.payload instanceof CronPayload ? init.payload : new CronPayload(init.payload ?? {});
    this.state =
      init.state instanceof CronJobState
        ? init.state
        : typeof init.state === "string"
          ? new CronJobState({ lastStatus: init.state as CronRunStatus })
          : new CronJobState(init.state ?? {});
    this.system = init.system ?? this.payload.kind === "systemEvent";
    const now = Date.now();
    this.createdAtMs = init.createdAtMs ?? now;
    this.updatedAtMs = init.updatedAtMs ?? now;
    this.deleteAfterRun = init.deleteAfterRun ?? false;
  }

  static fromObject(data: any): CronJob {
    return new CronJob(data);
  }

  toObject(): Record<string, any> {
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      schedule: this.schedule.toObject(),
      payload: this.payload.toObject(),
      state: this.state.toObject(),
      system: this.system,
      createdAtMs: this.createdAtMs,
      updatedAtMs: this.updatedAtMs,
      deleteAfterRun: this.deleteAfterRun,
    };
  }
}

export class CronStore {
  version: number;
  jobs: CronJob[];

  constructor(init: { version?: number; jobs?: Array<CronJob | ConstructorParameters<typeof CronJob>[0]> } = {}) {
    this.version = init.version ?? 1;
    this.jobs = (init.jobs ?? []).map((job: any) => (job instanceof CronJob ? job : new CronJob(job)));
  }

  toObject(): Record<string, any> {
    return {
      version: this.version,
      jobs: this.jobs.map((job) => job.toObject()),
    };
  }
}
