/**
 * Settings view.
 *
 *   - AI Models   — embedding / summarizer / **skill evolver** slots,
 *                   each with a "测试" button that calls
 *                   `POST /api/v1/models/test`.
 *   - Team Sharing — temporarily hidden until sharing is released.
 *   - General     — language, theme, telemetry, password protection,
 *                   and danger zone.
 *
 * All service-backed settings are updated optimistically and persisted in the
 * background. Successful writes stay silent; failures are surfaced and the
 * server remains responsible for hot-reloading the canonical config.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api/client";
import { classifyModelTestFailure } from "../model-test-error";
import { t, locale, setLocale } from "../stores/i18n";
import { theme, setTheme } from "../stores/theme";
import { health } from "../stores/health";
import { Icon } from "../components/Icon";
import { Select } from "../components/Select";
import { AgentSourceLogo } from "../components/AgentSourceLogo";
import { HubAdminPanel } from "../components/HubAdminPanel";
import { TEAM_SHARING_UI_ENABLED } from "../features";
import {
  triggerCleared,
  beginClearData,
  markClearResultUnknown,
  type ClearDataResponse,
} from "../stores/restart";

type Tab = "models" | "hub" | "agents" | "general";

interface ProviderBlock {
  provider?: string;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  batchSize?: number;
}

interface AgentAccessBlock {
  autoScanKnownAgents?: boolean;
  watchFileChanges?: boolean;
  autoInjectSkill?: boolean;
}

interface AgentSourceView {
  sourceId: string;
  displayName: string;
  dataPath: string;
  builtin: boolean;
  available: boolean;
  status: "not_connected" | "skill_installed" | "plugin_installed";
  messageCount: number;
  lastScannedAt: string | null;
}

interface ViewerCliStatus {
  installed: boolean;
  path: string;
}

interface ViewerCliInstallResult extends ViewerCliStatus {
  pathUpdated: boolean;
  profilePaths: string[];
}

interface MemoryServiceHealth {
  ok?: boolean;
  uptimeMs?: number;
}

interface AgentSourceScanState {
  running: boolean;
  jobId: string | null;
  sourceId: string | null;
  mode: "initial_subset" | "incremental" | "full" | null;
  progress: {
    sourceId: string;
    phase: "discover" | "read" | "redact" | "emit" | "scan" | "add" | "summarize" | "done" | "stopped";
    current: number;
    total: number;
    message?: string;
  } | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

type AgentSourceScanPhase = NonNullable<AgentSourceScanState["progress"]>["phase"];

interface InfrastructureFeedback {
  kind: "ok" | "error";
  text: string;
}

interface ResolvedConfig {
  version?: number;
  viewer?: { port: number; bindHost?: string };
  embedding?: ProviderBlock;
  llm?: ProviderBlock;
  skillEvolver?: ProviderBlock;
  hub?: {
    enabled?: boolean;
    role?: "hub" | "client";
    address?: string;
    port?: number;
    teamName?: string;
    teamToken?: string;
    nickname?: string;
  };
  telemetry?: { enabled?: boolean };
  agentAccess?: AgentAccessBlock;
}

interface EmbeddingMaintenanceStats {
  dimension: number;
  available: boolean;
  totalSlots: number;
  ready: number;
  missing: number;
  dimMismatch: number;
  needsRepair: number;
}

interface EmbeddingMaintenanceRunResult {
  mode: "repair" | "rebuild";
  processed: number;
  updated: number;
  failed: number;
  offset: number;
  nextOffset: number;
  done: boolean;
  statsAfter: EmbeddingMaintenanceStats;
  error?: string;
}

const SECRET_MASKED = (s: string | undefined | null): boolean =>
  !!s && (s === "__memos_secret__" || /^[\s•]+$/.test(s));

const EMBEDDING_PROVIDERS = [
  "local",
  "openai_compatible",
  "gemini",
];
const LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

const LLM_PROVIDERS = [
  "", // inherit from skill evolution
  "openai_compatible",
  "gemini",
  "anthropic",
];

const SKILL_PROVIDERS = [
  "", // inherit from Agent Chat
  "openai_compatible",
  "gemini",
  "anthropic",
];

function mergeConfig(
  base: Partial<ResolvedConfig>,
  patch: Partial<ResolvedConfig>,
): ResolvedConfig {
  return mergeConfigRecord(
    base as Record<string, unknown>,
    patch as Record<string, unknown>,
  ) as ResolvedConfig;
}

function mergeConfigRecord(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = next[key];
    next[key] = isConfigRecord(current) && isConfigRecord(value)
      ? mergeConfigRecord(current, value)
      : value;
  }
  return next;
}

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameConfig(left: ResolvedConfig | null, right: ResolvedConfig): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

export function SettingsView({ initialTab }: { initialTab?: Tab } = {}) {
  const [tab, setTab] = useState<Tab>(
    initialTab === "hub" && !TEAM_SHARING_UI_ENABLED
      ? "models"
      : initialTab ?? "models",
  );
  const [config, setConfig] = useState<ResolvedConfig | null>(null);
  const configRef = useRef<ResolvedConfig>({});
  const [error, setError] = useState<string | null>(null);
  const pendingPatch = useRef<Partial<ResolvedConfig>>({});
  const saveTimer = useRef<number | null>(null);
  const saveInFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .get<ResolvedConfig>("/api/v1/config", { signal: ctrl.signal })
      .then((next) => {
        configRef.current = next;
        setConfig(next);
      })
      .catch(() => {
        configRef.current = {};
        setConfig({});
      });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (saveInFlight.current || Object.keys(pendingPatch.current).length > 0) return;
      void api.get<ResolvedConfig>("/api/v1/config")
        .then((next) => {
          if (active) {
            setConfig((current) => {
              if (sameConfig(current, next)) return current;
              configRef.current = next;
              return next;
            });
          }
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(refresh, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => () => {
    mounted.current = false;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    void flushPendingConfig();
  }, []);

  const flushPendingConfig = async () => {
    if (saveInFlight.current) return;
    const nextPatch = pendingPatch.current;
    if (Object.keys(nextPatch).length === 0) return;
    pendingPatch.current = {};
    saveInFlight.current = true;
    try {
      await api.patch<ResolvedConfig>("/api/v1/config", nextPatch);
      if (mounted.current) setError(null);
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        try {
          const saved = await api.get<ResolvedConfig>("/api/v1/config");
          const next = mergeConfig(saved, pendingPatch.current);
          configRef.current = next;
          setConfig(next);
        } catch {
          // Keep the optimistic values visible while the service is unavailable.
        }
      }
    } finally {
      saveInFlight.current = false;
      if (Object.keys(pendingPatch.current).length > 0) scheduleConfigSave(0);
    }
  };

  const scheduleConfigSave = (delayMs: number) => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void flushPendingConfig();
    }, delayMs);
  };

  const patch = <K extends keyof ResolvedConfig>(
    key: K,
    partial: Partial<NonNullable<ResolvedConfig[K]>>,
    delayMs = 300,
  ) => {
    setError(null);
    const next = mergeConfig(configRef.current, { [key]: partial });
    configRef.current = next;
    setConfig(next);
    pendingPatch.current = mergeConfig(pendingPatch.current, {
      [key]: next[key],
    });
    scheduleConfigSave(delayMs);
  };

  const get = <K extends keyof ResolvedConfig>(
    key: K,
  ): ResolvedConfig[K] => config?.[key];

  const updateAgentAccess = async (
    partial: Partial<AgentAccessBlock>,
  ): Promise<AgentAccessBlock> => {
    const previous = (configRef.current.agentAccess ?? {}) as AgentAccessBlock;
    const optimistic = mergeConfig(configRef.current, {
      agentAccess: { ...previous, ...partial },
    });
    configRef.current = optimistic;
    setConfig(optimistic);
    try {
      const saved = await api.patch<ResolvedConfig>("/api/v1/config", {
        agentAccess: partial,
      });
      return saved.agentAccess ?? { ...previous, ...partial };
    } catch (cause) {
      const rolledBack = mergeConfig(configRef.current, { agentAccess: previous });
      configRef.current = rolledBack;
      setConfig(rolledBack);
      throw cause;
    }
  };

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{tab === "agents" ? t("settings.tab.agents") : t("settings.title")}</h1>
        </div>
      </div>

      {error && (
        <div class="card" role="alert" style="border-color:var(--danger);margin-bottom:var(--sp-4)">
          <div class="hstack">
            <Icon name="circle-alert" size={16} />
            <span>{error}</span>
          </div>
        </div>
      )}

      <div class="segmented" style="margin-bottom:var(--sp-6)">
        {[
          { v: "models" as Tab, k: "settings.tab.models" as const, icon: "cpu" as const },
          { v: "agents" as Tab, k: "settings.tab.agents" as const, icon: "link-2" as const },
          ...(TEAM_SHARING_UI_ENABLED
            ? [{ v: "hub" as Tab, k: "settings.tab.hub" as const, icon: "users" as const }]
            : []),
          { v: "general" as Tab, k: "settings.tab.general" as const, icon: "settings-2" as const },
        ].map((o) => (
          <button
            key={o.v}
            class="segmented__item"
            aria-pressed={tab === o.v}
            onClick={() => setTab(o.v)}
          >
            <Icon name={o.icon} size={14} />
            {t(o.k)}
          </button>
        ))}
      </div>

      {tab === "models" && (
        <ModelsTab
          embedding={(get("embedding") ?? {}) as ProviderBlock}
          llm={(get("llm") ?? {}) as ProviderBlock}
          skillEvolver={(get("skillEvolver") ?? {}) as ProviderBlock}
          onPatchEmbedding={(p) => patch("embedding", p)}
          onPatchLlm={(p) => patch("llm", p)}
          onPatchSkillEvolver={(p) => patch("skillEvolver", p)}
        />
      )}

      {TEAM_SHARING_UI_ENABLED && tab === "hub" && (
        <HubTab
          hub={(get("hub") ?? {}) as NonNullable<ResolvedConfig["hub"]>}
          onPatch={(p) => patch("hub", p)}
        />
      )}

      {tab === "agents" && (
        <AgentAccessTab
          agentAccess={(get("agentAccess") ?? {}) as AgentAccessBlock}
          onPatch={updateAgentAccess}
        />
      )}

      {tab === "general" && (
        <GeneralTab
          telemetry={(get("telemetry") ?? {}) as NonNullable<ResolvedConfig["telemetry"]>}
          onPatchTelemetry={(p) => patch("telemetry", p, 0)}
        />
      )}
    </>
  );
}

// ─── AI Models tab ───────────────────────────────────────────────────────

function ModelsTab({
  embedding,
  llm,
  skillEvolver,
  onPatchEmbedding,
  onPatchLlm,
  onPatchSkillEvolver,
}: {
  embedding: ProviderBlock;
  llm: ProviderBlock;
  skillEvolver: ProviderBlock;
  onPatchEmbedding: (p: Partial<ProviderBlock>) => void;
  onPatchLlm: (p: Partial<ProviderBlock>) => void;
  onPatchSkillEvolver: (p: Partial<ProviderBlock>) => void;
}) {
  return (
    <div class="vstack" style="gap:var(--sp-5)">
      <section
        class="card card--flat"
        style="border-left:3px solid var(--accent)"
      >
        <div class="hstack" style="gap:var(--sp-2);align-items:flex-start">
          <Icon name="info" size={14} style="margin-top:3px;flex-shrink:0;color:var(--accent)" />
          <div>
            <h3
              class="card__title"
              style="font-size:var(--fs-md);margin:0 0 var(--sp-2) 0"
            >
              {t("settings.model.tip.title")}
            </h3>
            <ul style="margin:0;padding-left:18px;font-size:var(--fs-sm);line-height:1.7;color:var(--fg)">
              <li>{t("settings.model.tip.embedding")}</li>
              <li>{t("settings.model.tip.summarizer")}</li>
              <li>{t("settings.model.tip.skillEvolver")}</li>
            </ul>
          </div>
        </div>
      </section>

      <ModelCard
        icon="plug"
        title={t("settings.embedding.title")}
        desc={t("settings.embedding.desc")}
        block={embedding}
        providers={EMBEDDING_PROVIDERS}
        type="embedding"
        localHint={t("settings.embedding.localHint")}
        onPatch={onPatchEmbedding}
      />

      <ModelCard
        icon="sparkles"
        title={t("settings.summarizer.title")}
        desc={t("settings.summarizer.desc")}
        block={llm}
        providers={LLM_PROVIDERS}
        type="summarizer"
        inheritsLabel={t("settings.summarizer.inherit")}
        onPatch={onPatchLlm}
      />

      <ModelCard
        icon="wand-sparkles"
        title={t("settings.skillEvolver.title")}
        desc={t("settings.skillEvolver.desc")}
        block={skillEvolver}
        providers={SKILL_PROVIDERS}
        type="skillEvolver"
        inheritsLabel={t("settings.skillEvolver.inherit")}
        onPatch={onPatchSkillEvolver}
      />
    </div>
  );
}

// ─── Model card with test button ─────────────────────────────────────────

function ModelCard({
  icon,
  title,
  desc,
  block,
  providers,
  type,
  extra,
  withTemperature,
  inheritsLabel,
  localHint,
  onPatch,
}: {
  icon: "plug" | "sparkles" | "wand-sparkles";
  title: string;
  desc: string;
  block: ProviderBlock;
  providers: string[];
  type: "embedding" | "summarizer" | "skillEvolver";
  extra?: preact.ComponentChildren;
  withTemperature?: boolean;
  inheritsLabel?: string;
  localHint?: string;
  onPatch: (p: Partial<ProviderBlock>) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<
    | { ok: true; latencyMs: number; dimensions?: number; responseChars?: number }
    | { ok: false; error: string }
    | null
  >(null);
  const selectedProvider = block.provider ?? providers[0];
  const inherits = (type === "skillEvolver" || type === "summarizer") && !selectedProvider;
  const isLocal = type === "embedding" && selectedProvider === "local";

  // `block.apiKey` from the server comes back masked as "••••". If we
  // echo that back in the request body it ends up in an HTTP header
  // server-side, and fetch() throws "Cannot convert argument to a
  // ByteString because the character at index 7 has a value of 8226"
  // (U+2022 • bullet) — exactly the crash the user hit after save+reload.
  //
  // The contract is: an empty / all-mask string means "keep using the
  // value already saved on disk"; anything else is a fresh key. The
  // backend /models/test route honours the same convention. We
  // recognise BOTH the historical `••••` mask and the ASCII-safe
  // `__memos_secret__` sentinel that replaced it — either means
  // "user hasn't re-entered the key, ignore it".
  const API_KEY_MASKED = (s: string | undefined | null): boolean =>
    !!s && (s === "__memos_secret__" || /^[\s•]+$/.test(s));
  const sanitizeApiKey = (s: string | undefined | null): string =>
    API_KEY_MASKED(s) ? "" : s ?? "";

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.post<typeof result>(`/api/v1/models/test`, {
        type,
        provider: selectedProvider,
        endpoint: block.endpoint,
        model: isLocal ? LOCAL_EMBEDDING_MODEL : block.model,
        apiKey: sanitizeApiKey(block.apiKey),
      });
      setResult(r);
    } catch (err) {
      const failureKind = await classifyModelTestFailure(
        err,
        () => api.get(`/api/v1/health`),
      );
      const errorMessage = err instanceof Error ? err.message : String(err);
      setResult({
        ok: false,
        error:
          failureKind === "viewer_offline"
            ? t("settings.test.viewerOffline")
            : `${t("settings.test.modelFailed")}: ${errorMessage}`,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section class="card">
      <div class="card__header">
        <div class="hstack">
          <span
            aria-hidden="true"
            style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-md);background:var(--accent-soft);color:var(--accent)"
          >
            <Icon name={icon} size={16} />
          </span>
          <div>
            <h3 class="card__title" style="margin:0">{title}</h3>
            <p class="card__subtitle" style="margin:0">{desc}</p>
          </div>
        </div>
        <button
          class="btn btn--sm"
          onClick={runTest}
          disabled={testing || inherits}
          title={inherits ? inheritsLabel : undefined}
        >
          <Icon name={testing ? "loader-2" : "plug"} size={14} class={testing ? "spin" : ""} />
          {testing ? t("common.loading") : t("settings.test")}
        </button>
      </div>

      {inherits && inheritsLabel && (
        <div
          style="font-size:var(--fs-xs);color:var(--fg-muted);margin-bottom:var(--sp-3);padding:var(--sp-2) var(--sp-3);background:var(--bg-canvas);border-radius:var(--radius-sm);border:1px dashed var(--border)"
        >
          {inheritsLabel}
        </div>
      )}
      {isLocal && localHint && (
        <div
          style="font-size:var(--fs-xs);color:var(--fg-muted);margin-bottom:var(--sp-3);padding:var(--sp-2) var(--sp-3);background:var(--bg-canvas);border-radius:var(--radius-sm);border:1px dashed var(--border)"
        >
          {localHint}
        </div>
      )}

      <div
        style={`display:grid;grid-template-columns:${
          type === "embedding"
            ? isLocal
              ? "repeat(2,minmax(0,1fr))"
              : "repeat(5,minmax(0,1fr))"
            : "repeat(auto-fit,minmax(240px,1fr))"
        };gap:var(--sp-4)`}
      >
        <Field label={type === "embedding" ? t("settings.embedding.providerLabel") : t("settings.provider")}>
          <Select
            value={selectedProvider}
            ariaLabel={type === "embedding" ? t("settings.embedding.providerLabel") : t("settings.provider")}
            options={providers.map((provider) => ({
              value: provider,
              label: modelProviderLabel(type, provider),
            }))}
            onChange={(provider) => onPatch({ provider })}
          />
        </Field>
        <Field label={t("settings.model")}>
          <input
            class="input"
            type="text"
            disabled={inherits || isLocal}
            value={isLocal ? LOCAL_EMBEDDING_MODEL : block.model ?? ""}
            placeholder="e.g. gpt-4o-mini"
            onInput={(e) => onPatch({ model: (e.target as HTMLInputElement).value })}
          />
        </Field>
        {!isLocal && (
          <Field label={t("settings.endpoint")}>
            <input
              class="input"
              type="url"
              disabled={inherits}
              value={block.endpoint ?? ""}
              placeholder="https://api.openai.com/v1"
              onInput={(e) => onPatch({ endpoint: (e.target as HTMLInputElement).value })}
            />
          </Field>
        )}
        {!isLocal && (
          <Field label={t("settings.apiKey")}>
            <input
              class="input"
              type="password"
              disabled={inherits}
              // Don't echo the masked "••••" back into the input — it
              // would ship bullet chars to /models/test and crash fetch
              // with "Cannot convert argument to a ByteString" (the
              // legacy viewer had the same bug until its 3.x rewrite).
              // Empty input = "keep the saved key"; the placeholder
              // makes that state legible.
              value={API_KEY_MASKED(block.apiKey) ? "" : block.apiKey ?? ""}
              placeholder={
                API_KEY_MASKED(block.apiKey) ? t("settings.apiKey.saved") : "sk-…"
              }
              onInput={(e) => onPatch({ apiKey: (e.target as HTMLInputElement).value })}
            />
          </Field>
        )}
        {type === "embedding" && !isLocal && (
          <Field label={t("settings.embedding.providerBatchSize.label")}>
            <input
              class="input"
              type="number"
              min={1}
              max={256}
              step={1}
              value={block.batchSize ?? 32}
              onInput={(e) =>
                onPatch({
                  batchSize: Math.max(
                    1,
                    Math.min(
                      256,
                      Math.floor(Number((e.target as HTMLInputElement).value) || 1),
                    ),
                  ),
                })}
            />
            <span class="muted" style="font-size:var(--fs-2xs)">
              {t("settings.embedding.providerBatchSize.hint")}
            </span>
          </Field>
        )}
        {withTemperature && (
          <Field label={t("settings.temperature")}>
            <input
              class="input"
              type="number"
              step={0.1}
              min={0}
              max={2}
              value={block.temperature ?? 0}
              onInput={(e) =>
                onPatch({
                  temperature: Number((e.target as HTMLInputElement).value) || 0,
                })
              }
            />
          </Field>
        )}
        {extra}
      </div>

      {result && (
        <div
          class="hstack"
          style={`margin-top:var(--sp-3);padding:var(--sp-2) var(--sp-3);border-radius:var(--radius-sm);background:${
            result.ok ? "var(--success-soft)" : "var(--danger-soft)"
          };color:${result.ok ? "var(--success)" : "var(--danger)"}`}
        >
          <Icon name={result.ok ? "check" : "circle-alert"} size={14} />
          {result.ok ? (
            <>
              <span style="font-weight:var(--fw-semi)">
                {t("settings.test.ok")}
              </span>
              <span class="muted" style="font-size:var(--fs-xs)">
                {result.latencyMs}ms
                {result.dimensions != null ? ` · dim ${result.dimensions}` : ""}
                {result.responseChars != null ? ` · ${result.responseChars} chars` : ""}
              </span>
            </>
          ) : (
            <span style="font-weight:var(--fw-semi)">{result.error}</span>
          )}
        </div>
      )}

      {type === "embedding" && <EmbeddingMaintenancePanel />}
    </section>
  );
}

function modelProviderLabel(
  type: "embedding" | "summarizer" | "skillEvolver",
  provider: string,
): string {
  if (!provider && type === "summarizer") {
    return t("settings.summarizer.inheritOption");
  }
  if (!provider && type === "skillEvolver") {
    return t("settings.skillEvolver.inheritOption");
  }
  if (type !== "embedding") return provider;
  if (provider === "local") return t("settings.embedding.provider.local");
  return provider;
}

function EmbeddingMaintenancePanel() {
  const [stats, setStats] = useState<EmbeddingMaintenanceStats | null>(null);
  const [running, setRunning] = useState<"repair" | "rebuild" | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "error" | "muted"; text: string } | null>(null);

  const refresh = async () => {
    try {
      setStats(await api.get<EmbeddingMaintenanceStats>("/api/v1/embeddings/maintenance"));
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (mode: "repair" | "rebuild") => {
    setRunning(mode);
    setStatus({ kind: "muted", text: t("settings.embedding.rebuild.running") });
    let offset = 0;
    let updated = 0;
    let failed = 0;
    try {
      for (;;) {
        const r = await api.post<EmbeddingMaintenanceRunResult>(
          "/api/v1/embeddings/rebuild",
          { mode, offset },
        );
        updated += r.updated;
        failed += r.failed;
        offset = r.nextOffset;
        setStats(r.statsAfter);
        setStatus({
          kind: "muted",
          text: t("settings.embedding.rebuild.progress", {
            updated,
            failed,
            remaining: r.statsAfter.needsRepair,
          }),
        });
        if (r.error) {
          setStatus({ kind: "error", text: r.error });
          break;
        }
        if (r.done) {
          setStatus({
            kind: failed > 0 ? "error" : "ok",
            text: t("settings.embedding.rebuild.done", { updated, failed }),
          });
          break;
        }
      }
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      setRunning(null);
      void refresh();
    }
  };

  const healthText = stats
    ? t("settings.embedding.maintenance.stats", {
        ready: stats.ready,
        total: stats.totalSlots,
        missing: stats.missing,
        mismatch: stats.dimMismatch,
        dim: stats.dimension,
      })
    : t("common.loading");
  const disabled = !!running || stats?.available === false;

  return (
    <div
      style="margin-top:var(--sp-4);padding:var(--sp-3);border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg-canvas)"
    >
      <div class="hstack" style="justify-content:space-between;gap:var(--sp-3);align-items:flex-start;flex-wrap:wrap">
        <div>
          <div style="font-weight:var(--fw-semi);font-size:var(--fs-sm)">
            {t("settings.embedding.maintenance.title")}
          </div>
          <div class="muted" style="font-size:var(--fs-xs);margin-top:2px">
            {healthText}
          </div>
        </div>
        <div class="hstack" style="gap:var(--sp-2);flex-wrap:wrap">
          <button class="btn btn--sm" onClick={() => void refresh()} disabled={!!running}>
            <Icon name="refresh-cw" size={14} />
            {t("common.refresh")}
          </button>
          <button class="btn btn--sm" onClick={() => void run("repair")} disabled={disabled || stats?.needsRepair === 0}>
            <Icon name={running === "repair" ? "loader-2" : "plug"} size={14} class={running === "repair" ? "spin" : ""} />
            {t("settings.embedding.repair")}
          </button>
          <button class="btn btn--primary btn--sm" onClick={() => void run("rebuild")} disabled={disabled || stats?.totalSlots === 0}>
            <Icon name={running === "rebuild" ? "loader-2" : "refresh-cw"} size={14} class={running === "rebuild" ? "spin" : ""} />
            {t("settings.embedding.rebuild")}
          </button>
        </div>
      </div>
      {stats?.available === false && (
        <div class="muted" style="font-size:var(--fs-xs);margin-top:var(--sp-2)">
          {t("settings.embedding.maintenance.unavailable")}
        </div>
      )}
      {status && (
        <div
          role="status"
          style={`margin-top:var(--sp-2);font-size:var(--fs-xs);color:${
            status.kind === "ok"
              ? "var(--success)"
              : status.kind === "error"
                ? "var(--danger)"
                : "var(--fg-muted)"
          }`}
        >
          {status.text}
        </div>
      )}
    </div>
  );
}

// ─── Hub tab ─────────────────────────────────────────────────────────────

function HubTab({
  hub,
  onPatch,
}: {
  hub: NonNullable<ResolvedConfig["hub"]>;
  onPatch: (p: Partial<NonNullable<ResolvedConfig["hub"]>>) => void;
}) {
  return (
    <div class="card">
      <div class="hstack" style="justify-content:space-between;margin-bottom:var(--sp-4)">
        <div>
          <h3 class="card__title">{t("settings.hub.enabled")}</h3>
          <p class="card__subtitle">
            {t("settings.hub.subtitle")}
          </p>
        </div>
        <ToggleSwitch
          checked={!!hub.enabled}
          onChange={(v) => onPatch({ enabled: v })}
        />
      </div>

      {hub.enabled && (
        <>
          <div
            style="margin-bottom:var(--sp-4);padding:var(--sp-3);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--radius-md);background:var(--bg-canvas)"
          >
            <div class="hstack" style="gap:var(--sp-2);align-items:flex-start">
              <Icon name="info" size={14} style="margin-top:3px;color:var(--accent);flex-shrink:0" />
              <div style="font-size:var(--fs-sm);line-height:1.7">
                <div style="font-weight:var(--fw-semi);margin-bottom:4px">
                  {hub.role === "hub" ? t("settings.hub.mode.hub.title") : t("settings.hub.mode.client.title")}
                </div>
                <div class="muted">
                  {hub.role === "hub" ? t("settings.hub.mode.hub.desc") : t("settings.hub.mode.client.desc")}
                </div>
              </div>
            </div>
          </div>

          <div
            style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--sp-4)"
          >
            <Field label={t("settings.hub.role")}>
              <div class="segmented">
                {(["hub", "client"] as const).map((r) => (
                  <button
                    key={r}
                    class="segmented__item"
                    aria-pressed={hub.role === r}
                    onClick={() => onPatch({ role: r })}
                  >
                    {t(`settings.hub.role.${r}` as "settings.hub.role.hub")}
                  </button>
                ))}
              </div>
            </Field>

            {hub.role === "client" && (
              <Field label={t("settings.hub.address")}>
                <input
                  class="input"
                  type="url"
                  value={hub.address ?? ""}
                  placeholder="http://10.0.0.12:18912"
                  onInput={(e) =>
                    onPatch({ address: (e.target as HTMLInputElement).value })
                  }
                />
              </Field>
            )}

            {hub.role === "hub" && (
              <Field label={t("settings.hub.teamName")}>
                <input
                  class="input"
                  type="text"
                  value={hub.teamName ?? ""}
                  placeholder="MemOS Team"
                  onInput={(e) =>
                    onPatch({ teamName: (e.target as HTMLInputElement).value })
                  }
                />
              </Field>
            )}

            {hub.role === "hub" && (
              <Field label={t("settings.hub.port")}>
                <input
                  class="input"
                  type="number"
                  min={1}
                  max={65535}
                  value={hub.port ?? 18912}
                  onInput={(e) =>
                    onPatch({ port: Number((e.target as HTMLInputElement).value) || 18912 })
                  }
                />
              </Field>
            )}

            {hub.role === "client" && (
              <Field label={t("settings.hub.nickname")}>
                <input
                  class="input"
                  type="text"
                  value={hub.nickname ?? ""}
                  placeholder={t("settings.hub.nickname.placeholder")}
                  onInput={(e) =>
                    onPatch({ nickname: (e.target as HTMLInputElement).value })
                  }
                />
              </Field>
            )}

            <Field label={t("settings.hub.teamToken")}>
              <input
                class="input"
                type="password"
                value={SECRET_MASKED(hub.teamToken) ? "" : hub.teamToken ?? ""}
                placeholder={
                  SECRET_MASKED(hub.teamToken)
                    ? t("settings.apiKey.saved")
                    : t("settings.hub.teamToken.placeholder")
                }
                onInput={(e) =>
                  onPatch({ teamToken: (e.target as HTMLInputElement).value })
                }
              />
            </Field>

          </div>
        </>
      )}

      {hub.enabled && (
        <div style="margin-top:var(--sp-5);padding-top:var(--sp-4);border-top:1px solid var(--border)">
          <h4
            class="card__title"
            style="font-size:var(--fs-md);margin-bottom:var(--sp-3)"
          >
            {hub.role === "hub" ? t("settings.hub.admin") : t("settings.hub.status")}
          </h4>
          <HubAdminPanel hasUnsavedHubChanges={false} />
        </div>
      )}
    </div>
  );
}

// ─── Cross-Agent access tab ──────────────────────────────────────────

function AgentAccessTab({
  agentAccess,
  onPatch,
}: {
  agentAccess: AgentAccessBlock;
  onPatch: (patch: Partial<AgentAccessBlock>) => Promise<AgentAccessBlock>;
}) {
  const [sources, setSources] = useState<AgentSourceView[]>([]);
  const sourcesRef = useRef<AgentSourceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busySource, setBusySource] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cliStatus, setCliStatus] = useState<ViewerCliStatus | null>(null);
  const [cliStatusFailed, setCliStatusFailed] = useState(false);
  const [cliBusy, setCliBusy] = useState(false);
  const [serviceBusy, setServiceBusy] = useState(false);
  const [scanStatus, setScanStatus] = useState<AgentSourceScanState | null>(null);
  const [scanControlBusy, setScanControlBusy] = useState<"pause" | "resume" | "cancel" | null>(null);
  const [scanCompletion, setScanCompletion] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showFullScanConfirm, setShowFullScanConfirm] = useState(false);
  const [fullScanTargetSourceId, setFullScanTargetSourceId] = useState("");
  const [cliFeedback, setCliFeedback] = useState<InfrastructureFeedback | null>(null);
  const [serviceFeedback, setServiceFeedback] = useState<InfrastructureFeedback | null>(null);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const activeScanJob = useRef<string | null>(null);
  const scannableSources = visibleAgentSources(sources);
  const scanPaused = scanStatus?.progress?.phase === "stopped";
  const scanSessionActive = scanStatus?.running === true || scanPaused;
  const scanProgress = scanStatus?.progress;
  const scanDeterminate = Boolean(scanProgress && scanProgress.total > 0);
  const scanPercent = scanDeterminate && scanProgress
    ? Math.max(0, Math.min(scanProgress.phase === "done" ? 100 : 99, Math.round((scanProgress.current / scanProgress.total) * 100)))
    : 0;
  const scanSourceName = sourceDisplayName(
    scanStatus?.sourceId ?? scanProgress?.sourceId ?? "all",
    sources,
  );

  const loadSources = async () => {
    try {
      const response = await api.get<{ executorAvailable: true; sources: AgentSourceView[] }>(
        "/api/v1/agent-sources",
      );
      sourcesRef.current = response.sources;
      setSources(response.sources);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSources();
    void api
      .get<ViewerCliStatus>("/api/v1/system/cli")
      .then(setCliStatus)
      .catch(() => {
        setCliStatusFailed(true);
        setCliFeedback({
          kind: "error",
          text: t("settings.agents.cliStatusFailed"),
        });
      });
    let active = true;
    const refreshScan = async () => {
      try {
        const next = await api.get<AgentSourceScanState>("/api/v1/agent-sources/scan/status");
        if (!active) return;
        const paused = next.progress?.phase === "stopped";
        if (next.running || paused) {
          activeScanJob.current = next.jobId;
          setScanStatus(next);
          setBusySource(next.running ? next.sourceId ?? next.progress?.sourceId ?? "all" : null);
          return;
        }
        if (activeScanJob.current && next.jobId === activeScanJob.current) {
          const completedSourceId = next.sourceId ?? next.progress?.sourceId ?? "all";
          activeScanJob.current = null;
          setScanStatus(null);
          setBusySource(null);
          if (next.error) {
            setMessage(next.error);
          } else {
            setScanCompletion(t("settings.agents.scanCompletedNotice", {
              agent: sourceDisplayName(completedSourceId, sourcesRef.current),
            }));
          }
          await loadSources();
        }
      } catch {
        // Other infrastructure status remains usable while scan polling is unavailable.
      }
    };
    void refreshScan();
    const timer = window.setInterval(() => void refreshScan(), 500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const installCli = async () => {
    setCliBusy(true);
    setCliFeedback(null);
    try {
      const result = await api.post<ViewerCliInstallResult>("/api/v1/system/cli/install", {});
      setCliStatus(result);
      setCliStatusFailed(false);
      setCliFeedback({
        kind: "ok",
        text: result.pathUpdated
          ? t("settings.agents.cliInstalledPathUpdated", {
              path: result.path,
              profiles: formatProfilePaths(result.profilePaths),
            })
          : t("settings.agents.cliInstalled", { path: result.path }),
      });
    } catch (error) {
      setCliFeedback({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCliBusy(false);
    }
  };

  const restartService = async () => {
    setServiceBusy(true);
    setServiceFeedback(null);
    try {
      const before = await api.get<MemoryServiceHealth>("/api/v1/health");
      const requestedAt = Date.now();
      await api.post("/api/v1/system/restart", {});
      const running = await waitForMemoryService(before.uptimeMs, requestedAt);
      if (!running) throw new Error(t("settings.agents.serviceRestartFailed"));
      setServiceFeedback({ kind: "ok", text: t("settings.agents.serviceRestarted") });
    } catch (error) {
      setServiceFeedback({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setServiceBusy(false);
    }
  };

  const scan = async (sourceId: string, mode?: "full") => {
    setBusySource(sourceId);
    setMessage(null);
    setScanCompletion(null);
    try {
      const result = await api.post<{ accepted: true; jobId: string }>(
        "/api/v1/agent-sources/scan",
        { sourceId, ...(mode ? { mode } : {}) },
      );
      activeScanJob.current = result.jobId;
      setScanStatus({
        running: true,
        jobId: result.jobId,
        sourceId,
        mode: mode ?? null,
        progress: {
          sourceId,
          phase: "scan",
          current: 0,
          total: 0,
        },
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setBusySource(null);
    }
  };

  const pauseScan = async () => {
    if (!scanStatus?.running) return;
    setScanControlBusy("pause");
    setMessage(null);
    try {
      await api.post("/api/v1/agent-sources/scan/stop", {});
      const next = await api.get<AgentSourceScanState>("/api/v1/agent-sources/scan/status");
      setScanStatus(next);
      setBusySource(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setScanControlBusy(null);
    }
  };

  const resumeScan = async () => {
    const sourceId = scanStatus?.sourceId ?? scanStatus?.progress?.sourceId;
    if (!scanPaused || !sourceId) return;
    setScanControlBusy("resume");
    try {
      await scan(sourceId, scanStatus?.mode === "full" ? "full" : undefined);
    } finally {
      setScanControlBusy(null);
    }
  };

  const cancelScan = async () => {
    if (!scanSessionActive) return;
    setScanControlBusy("cancel");
    setMessage(null);
    try {
      await api.post("/api/v1/agent-sources/scan/cancel", {});
      activeScanJob.current = null;
      setScanStatus(null);
      setBusySource(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setScanControlBusy(null);
    }
  };

  const openFullScanConfirm = () => {
    setFullScanTargetSourceId("");
    setShowFullScanConfirm(true);
  };

  const startFullScan = () => {
    if (!fullScanTargetSourceId) return;
    const sourceId = fullScanTargetSourceId;
    setShowFullScanConfirm(false);
    void scan(sourceId, "full");
  };

  const toggleConnection = async (source: AgentSourceView) => {
    const kind = agentConnectionKind(source.sourceId);
    const connected = source.status !== "not_connected";
    setBusySource(source.sourceId);
    setMessage(null);
    try {
      if (connected) {
        await api.del(`/api/v1/agent-sources/${encodeURIComponent(source.sourceId)}/${kind}`);
      } else {
        await api.post(`/api/v1/agent-sources/${encodeURIComponent(source.sourceId)}/${kind}`, {});
      }
      await loadSources();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusySource(null);
    }
  };

  const updateAutomation = async (patch: Partial<AgentAccessBlock>) => {
    if (automationBusy) return;
    setAutomationBusy(true);
    setAutomationError(null);
    try {
      await onPatch(patch);
    } catch (error) {
      setAutomationError(
        t("settings.agents.automationSaveFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setAutomationBusy(false);
    }
  };

  return (
    <div class="vstack" style="gap:var(--sp-5)">
      <section class="card">
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--sp-5)">
          <InfrastructureItem
            icon="cable"
            title={t("settings.agents.cli")}
            status={cliStatusFailed ? "error" : cliStatus === null ? "checking" : cliStatus.installed ? "ok" : "error"}
            okLabel={t("settings.agents.installed")}
            errorLabel={t(cliStatusFailed ? "settings.agents.statusUnavailable" : "settings.agents.notInstalled")}
            value={cliStatus?.path ?? "~/.local/bin/memmy-memory"}
            description={t("settings.agents.cli.desc")}
            actionLabel={t(
              cliBusy
                ? "settings.agents.cliInstalling"
                : cliStatus?.installed
                  ? "settings.agents.reinstallPath"
                  : "settings.agents.installPath",
            )}
            busy={cliBusy}
            onAction={() => void installCli()}
            feedback={cliFeedback}
          />
          <InfrastructureItem
            icon="database"
            title={t("settings.agents.service")}
            status={serviceBusy ? "checking" : "ok"}
            okLabel={t("settings.agents.running")}
            errorLabel={t("settings.agents.stopped")}
            value={memoryServiceEndpoint()}
            description={t("settings.agents.service.desc")}
            actionLabel={t(
              serviceBusy
                ? "settings.agents.serviceRestarting"
                : "settings.agents.restartService",
            )}
            busy={serviceBusy}
            onAction={() => void restartService()}
            feedback={serviceFeedback}
            bordered
          />
        </div>
      </section>

      <section class="card card--flat" style="border-left:3px solid var(--accent)">
        <div class="hstack" style="gap:var(--sp-2);align-items:flex-start">
          <Icon name="info" size={14} style="margin-top:3px;flex-shrink:0;color:var(--accent)" />
          <div class="vstack" style="gap:var(--sp-1);font-size:var(--fs-sm);line-height:1.6">
            <p style="margin:0">{t("settings.agents.scanHint")}</p>
            <p style="margin:0">{t("settings.agents.incrementHint")}</p>
          </div>
        </div>
      </section>

      {scanCompletion && (
        <div class="agent-scan-notice" role="status">
          <Icon name="circle-check-big" size={16} />
          <span>{scanCompletion}</span>
        </div>
      )}

      {scanSessionActive && (
        <section class="agent-scan-progress" aria-busy={scanStatus?.running === true}>
          <div class="agent-scan-progress__header">
            <div class="agent-scan-progress__summary">
              <span class={`agent-scan-progress__icon${scanStatus?.running ? " agent-scan-progress__icon--running" : ""}`}>
                <Icon name="refresh-cw" size={18} class={scanStatus?.running ? "spin" : ""} />
              </span>
              <div>
                <h3 class="agent-scan-progress__title">
                  {t(scanProgressTitleKey(scanProgress?.phase ?? "scan"))}
                </h3>
                <p class="agent-scan-progress__description">
                  {scanDeterminate && scanProgress
                    ? t("settings.agents.scanProgress.count", {
                        agent: scanSourceName,
                        current: scanProgress.current,
                        total: scanProgress.total,
                      })
                    : t("settings.agents.scanProgress.indeterminate", {
                        agent: scanSourceName,
                        current: scanProgress?.current ?? 0,
                      })}
                </p>
              </div>
            </div>
          </div>
          <div class="agent-scan-progress__controls">
            <div class="agent-scan-progress__track" aria-hidden="true">
              <span
                class={`agent-scan-progress__fill${scanDeterminate ? "" : " agent-scan-progress__fill--indeterminate"}${scanPaused ? " agent-scan-progress__fill--paused" : ""}`}
                style={scanDeterminate ? `width:${scanPercent}%` : undefined}
              />
            </div>
            <button
              class="btn btn--ghost btn--sm"
              disabled={scanControlBusy !== null}
              onClick={() => void (scanPaused ? resumeScan() : pauseScan())}
            >
              <Icon
                name={scanControlBusy === "pause" || scanControlBusy === "resume" ? "loader-2" : scanPaused ? "play" : "pause"}
                size={13}
                class={scanControlBusy === "pause" || scanControlBusy === "resume" ? "spin" : ""}
              />
              {t(scanPaused ? "settings.agents.scanContinue" : "settings.agents.scanPause")}
            </button>
            <button
              class="btn btn--danger btn--sm"
              disabled={scanControlBusy !== null}
              onClick={() => void cancelScan()}
            >
              <Icon name={scanControlBusy === "cancel" ? "loader-2" : "x"} size={13} class={scanControlBusy === "cancel" ? "spin" : ""} />
              {t("settings.agents.scanStop")}
            </button>
          </div>
          <div class="agent-scan-progress__meta">
            <span>{t(scanProgressPhaseKey(scanProgress?.phase ?? "scan"))}</span>
            <span>{scanPaused ? "" : scanDeterminate ? `${scanPercent}%` : t("settings.agents.scanProgress.waiting")}</span>
          </div>
        </section>
      )}

      <section class="card">
        <div class="card__header" style="margin-bottom:var(--sp-3)">
          <div>
            <h3 class="card__title">
              {t("settings.agents.sources", { count: visibleAgentSources(sources).length })}
            </h3>
            <p class="card__subtitle">{t("settings.agents.sources.desc")}</p>
          </div>
          <button
            class="btn btn--primary btn--sm"
            disabled={scanSessionActive || busySource !== null}
            onClick={() => void scan("all")}
          >
            <Icon name={busySource === "all" ? "loader-2" : "refresh-cw"} size={14} class={busySource === "all" ? "spin" : ""} />
            {t("settings.agents.syncNew")}
          </button>
        </div>

        {message && <p class="card__subtitle" role="status" style="margin-bottom:var(--sp-3)">{message}</p>}
        {loading ? (
          <div class="empty"><Icon name="loader-2" size={18} class="spin" /></div>
        ) : (
          <div class="vstack" style="gap:var(--sp-2)">
            {visibleAgentSources(sources).map((source) => {
              const connected = source.status !== "not_connected";
              const busy = busySource === source.sourceId;
              const action = agentConnectionAction(source);
              return (
                <div class="card card--flat agent-source-item" key={source.sourceId}>
                  <div class="agent-source-item__identity">
                    <AgentSourceLogo sourceId={source.sourceId} displayName={source.displayName} />
                    <div style="min-width:0">
                      <div class="hstack" style="gap:var(--sp-2)">
                        <strong>{source.displayName}</strong>
                        <span class={`pill ${connected ? "pill--active" : source.available ? "pill--info" : "pill--subtle"}`}>
                          {t(agentStatusKey(source))}
                        </span>
                      </div>
                      <p class="card__subtitle agent-source-item__meta">
                        {t("settings.agents.memoryCount", { count: source.messageCount })}
                        {source.dataPath ? ` · ${source.dataPath}` : ""}
                      </p>
                    </div>
                  </div>
                  <div class="hstack" style="gap:var(--sp-2);flex-shrink:0">
                    <button
                      class={`btn btn--sm ${connected ? "btn--danger" : "btn--primary"}`}
                      disabled={!source.available || scanSessionActive || busySource !== null}
                      onClick={() => void toggleConnection(source)}
                    >
                      <Icon name={busy ? "loader-2" : agentActionIcon(action)} size={13} class={busy ? "spin" : ""} />
                      {t(agentActionKey(action))}
                    </button>
                    <button
                      class="btn btn--ghost btn--sm"
                      disabled={!source.available || scanSessionActive || busySource !== null}
                      onClick={() => void scan(source.sourceId)}
                    >
                      <Icon name={busy ? "loader-2" : "refresh-cw"} size={13} class={busy ? "spin" : ""} />
                      {t(source.lastScannedAt ? "settings.agents.syncNew" : "settings.agents.firstScan")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div class="card card--flat" style="margin-top:var(--sp-3)">
          <button
            class="btn btn--ghost btn--sm"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((value) => !value)}
          >
            <Icon name="settings-2" size={13} />
            {t("settings.agents.advanced")}
          </button>
          {showAdvanced && (
            <div style="margin-top:var(--sp-3);padding-top:var(--sp-3);border-top:1px solid var(--border)">
              <div class="hstack" style="justify-content:space-between;gap:var(--sp-4)">
                <div>
                  <h4 class="card__title" style="font-size:var(--fs-md)">
                    {t("settings.agents.deepScan")}
                  </h4>
                  <p class="card__subtitle">{t("settings.agents.deepScan.desc")}</p>
                </div>
                <button
                  class="btn btn--danger btn--sm"
                  disabled={scanSessionActive || busySource !== null}
                  onClick={openFullScanConfirm}
                >
                  <Icon name="history" size={13} />
                  {t("settings.agents.deepScan.action")}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section class="card">
        <div class="card__header" style="margin-bottom:var(--sp-3)">
          <h3 class="card__title">{t("settings.agents.automation")}</h3>
        </div>
        <div class="vstack" style="gap:var(--sp-4)">
          <SettingToggle
            title={t("settings.agents.startupScan")}
            description={t("settings.agents.startupScan.desc")}
            checked={agentAccess.autoScanKnownAgents !== false}
            disabled={automationBusy}
            onChange={(checked) => void updateAutomation({ autoScanKnownAgents: checked })}
          />
          <SettingToggle
            title={t("settings.agents.scheduledScan")}
            description={t("settings.agents.scheduledScan.desc")}
            checked={agentAccess.watchFileChanges !== false}
            disabled={automationBusy}
            onChange={(checked) => void updateAutomation({ watchFileChanges: checked })}
          />
          <SettingToggle
            title={t("settings.agents.autoConnect")}
            description={t("settings.agents.autoConnect.desc")}
            checked={agentAccess.autoInjectSkill === true}
            disabled={automationBusy}
            onChange={(checked) => void updateAutomation({ autoInjectSkill: checked })}
          />
        </div>
        {automationError && (
          <p
            role="alert"
            style="margin:var(--sp-3) 0 0;color:var(--danger);font-size:var(--fs-xs)"
          >
            {automationError}
          </p>
        )}
      </section>

      {showFullScanConfirm && (
        <div class="modal-backdrop" onClick={() => setShowFullScanConfirm(false)}>
          <div
            class="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="full-scan-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="modal__header">
              <div class="hstack" style="gap:var(--sp-2);align-items:center">
                <span class="full-scan-dialog__icon">
                  <Icon name="circle-alert" size={17} />
                </span>
                <h3 id="full-scan-dialog-title" class="modal__title">
                  {t("settings.agents.deepScan.confirmTitle")}
                </h3>
              </div>
            </div>
            <div class="modal__body">
              <p class="full-scan-dialog__description">
                {t("settings.agents.deepScan.confirmBody")}
              </p>
              <div>
                <div class="full-scan-targets__label">
                  {t("settings.agents.deepScan.targetLabel")}
                </div>
                <div
                  class="full-scan-targets"
                  role="radiogroup"
                  aria-label={t("settings.agents.deepScan.targetLabel")}
                >
                  <FullScanTargetOption
                    checked={fullScanTargetSourceId === "all"}
                    label={t("settings.agents.deepScan.targetAll")}
                    description={t("settings.agents.deepScan.targetAllDescription", {
                      count: scannableSources.length,
                    })}
                    onChange={() => setFullScanTargetSourceId("all")}
                  />
                  {scannableSources.map((source) => (
                    <FullScanTargetOption
                      key={source.sourceId}
                      checked={fullScanTargetSourceId === source.sourceId}
                      label={source.displayName}
                      description={t("settings.agents.memoryCount", { count: source.messageCount })}
                      onChange={() => setFullScanTargetSourceId(source.sourceId)}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div class="modal__footer">
              <button
                class="btn btn--ghost btn--sm"
                onClick={() => setShowFullScanConfirm(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                class="btn btn--danger btn--sm"
                disabled={!fullScanTargetSourceId || scanSessionActive || busySource !== null}
                onClick={startFullScan}
              >
                <Icon name="history" size={13} />
                {t("settings.agents.deepScan.action")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FullScanTargetOption({
  checked,
  label,
  description,
  onChange,
}: {
  checked: boolean;
  label: string;
  description: string;
  onChange: () => void;
}) {
  return (
    <label class={`full-scan-target${checked ? " full-scan-target--selected" : ""}`}>
      <input
        class="full-scan-target__input"
        type="radio"
        name="memory-full-scan-target"
        checked={checked}
        onChange={onChange}
      />
      <span class="full-scan-target__radio" aria-hidden="true">
        {checked && <span />}
      </span>
      <span class="full-scan-target__content">
        <span class="full-scan-target__label">{label}</span>
        <span class="full-scan-target__description">{description}</span>
      </span>
    </label>
  );
}

function InfrastructureItem({
  icon,
  title,
  status,
  okLabel,
  errorLabel,
  value,
  description,
  actionLabel,
  busy,
  feedback,
  bordered,
  onAction,
}: {
  icon: "cable" | "database";
  title: string;
  status: "checking" | "ok" | "error";
  okLabel: string;
  errorLabel: string;
  value: string;
  description: string;
  actionLabel: string;
  busy: boolean;
  feedback?: InfrastructureFeedback | null;
  bordered?: boolean;
  onAction: () => void;
}) {
  return (
    <div style={bordered ? "border-left:1px solid var(--border);padding-left:var(--sp-5)" : undefined}>
      <div class="hstack" style="justify-content:space-between;margin-bottom:var(--sp-2)">
        <div class="hstack" style="gap:var(--sp-2)">
          <Icon name={icon} size={14} />
          <strong style="font-size:var(--fs-sm)">{title}</strong>
        </div>
        <span class={`pill ${status === "ok" ? "pill--active" : status === "error" ? "pill--failed" : "pill--subtle"}`}>
          {status === "ok" ? okLabel : status === "error" ? errorLabel : t("common.loading")}
        </span>
      </div>
      <code class="mono muted" style="display:block;font-size:var(--fs-xs);margin-bottom:var(--sp-2)">{value}</code>
      <p class="card__subtitle" style="margin-bottom:var(--sp-2)">{description}</p>
      <button class="btn btn--ghost btn--sm" disabled={busy} onClick={onAction}>
        <Icon name={busy ? "loader-2" : "refresh-cw"} size={13} class={busy ? "spin" : ""} />
        {actionLabel}
      </button>
      {feedback && (
        <p
          role={feedback.kind === "error" ? "alert" : "status"}
          style={`margin:var(--sp-3) 0 0;color:${feedback.kind === "error" ? "var(--danger)" : "var(--success)"};font-size:var(--fs-xs)`}
        >
          {feedback.text}
        </p>
      )}
    </div>
  );
}

function SettingToggle({
  title,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div class="hstack" style="justify-content:space-between;gap:var(--sp-4)">
      <div>
        <h4 class="card__title" style="font-size:var(--fs-md)">{title}</h4>
        <p class="card__subtitle">{description}</p>
      </div>
      <ToggleSwitch checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );
}

const NATIVE_PLUGIN_AGENT_IDS = new Set(["opencode", "openclaw", "hermes", "deepseek_harness"]);
const HOOK_AGENT_IDS = new Set(["codex", "claude_code", "cursor"]);

type AgentConnectionAction =
  | "install_plugin"
  | "remove_plugin"
  | "install_hook"
  | "remove_hook"
  | "install_skill"
  | "remove_skill";

function visibleAgentSources(sources: AgentSourceView[]): AgentSourceView[] {
  return sources.filter((source) => !source.builtin || source.available);
}

function sourceDisplayName(sourceId: string, sources: AgentSourceView[]): string {
  if (sourceId === "all") return t("settings.agents.deepScan.targetAll");
  return sources.find((source) => source.sourceId === sourceId)?.displayName ?? sourceId;
}

function scanProgressTitleKey(phase: AgentSourceScanPhase):
  | "settings.agents.scanProgress.title.scan"
  | "settings.agents.scanProgress.title.add"
  | "settings.agents.scanProgress.title.summarize"
  | "settings.agents.scanProgress.title.done"
  | "settings.agents.scanProgress.title.stopped" {
  if (phase === "add" || phase === "emit") return "settings.agents.scanProgress.title.add";
  if (phase === "summarize") return "settings.agents.scanProgress.title.summarize";
  if (phase === "done") return "settings.agents.scanProgress.title.done";
  if (phase === "stopped") return "settings.agents.scanProgress.title.stopped";
  return "settings.agents.scanProgress.title.scan";
}

function scanProgressPhaseKey(phase: AgentSourceScanPhase):
  | "settings.agents.scanProgress.phase.discover"
  | "settings.agents.scanProgress.phase.read"
  | "settings.agents.scanProgress.phase.redact"
  | "settings.agents.scanProgress.phase.emit"
  | "settings.agents.scanProgress.phase.scan"
  | "settings.agents.scanProgress.phase.add"
  | "settings.agents.scanProgress.phase.summarize"
  | "settings.agents.scanProgress.phase.done"
  | "settings.agents.scanProgress.phase.stopped" {
  const keys = {
    discover: "settings.agents.scanProgress.phase.discover",
    read: "settings.agents.scanProgress.phase.read",
    redact: "settings.agents.scanProgress.phase.redact",
    emit: "settings.agents.scanProgress.phase.emit",
    scan: "settings.agents.scanProgress.phase.scan",
    add: "settings.agents.scanProgress.phase.add",
    summarize: "settings.agents.scanProgress.phase.summarize",
    done: "settings.agents.scanProgress.phase.done",
    stopped: "settings.agents.scanProgress.phase.stopped",
  } as const;
  return keys[phase];
}

function agentConnectionAction(source: AgentSourceView): AgentConnectionAction {
  if (NATIVE_PLUGIN_AGENT_IDS.has(source.sourceId)) {
    return source.status === "plugin_installed" ? "remove_plugin" : "install_plugin";
  }
  if (HOOK_AGENT_IDS.has(source.sourceId)) {
    return source.status === "plugin_installed" ? "remove_hook" : "install_hook";
  }
  return source.status === "not_connected" ? "install_skill" : "remove_skill";
}

function agentConnectionKind(sourceId: string): "plugin" | "skill" {
  return NATIVE_PLUGIN_AGENT_IDS.has(sourceId) || HOOK_AGENT_IDS.has(sourceId)
    ? "plugin"
    : "skill";
}

function agentStatusKey(source: AgentSourceView):
  | "settings.agents.skillInstalled"
  | "settings.agents.hookInstalled"
  | "settings.agents.pluginInstalled"
  | "settings.agents.skillNotInstalled"
  | "settings.agents.hookNotInstalled"
  | "settings.agents.pluginNotInstalled" {
  if (source.status === "skill_installed") return "settings.agents.skillInstalled";
  if (source.status === "plugin_installed") {
    return HOOK_AGENT_IDS.has(source.sourceId)
      ? "settings.agents.hookInstalled"
      : "settings.agents.pluginInstalled";
  }
  if (NATIVE_PLUGIN_AGENT_IDS.has(source.sourceId)) return "settings.agents.pluginNotInstalled";
  return HOOK_AGENT_IDS.has(source.sourceId)
    ? "settings.agents.hookNotInstalled"
    : "settings.agents.skillNotInstalled";
}

function agentActionKey(action: AgentConnectionAction):
  | "settings.agents.installSkill"
  | "settings.agents.installHook"
  | "settings.agents.installPlugin"
  | "settings.agents.removeSkill"
  | "settings.agents.removeHook"
  | "settings.agents.removePlugin" {
  const keys = {
    install_skill: "settings.agents.installSkill",
    install_hook: "settings.agents.installHook",
    install_plugin: "settings.agents.installPlugin",
    remove_skill: "settings.agents.removeSkill",
    remove_hook: "settings.agents.removeHook",
    remove_plugin: "settings.agents.removePlugin",
  } as const;
  return keys[action];
}

function agentActionIcon(action: AgentConnectionAction):
  | "plug"
  | "terminal"
  | "download"
  | "trash-2" {
  if (action === "install_plugin") return "plug";
  if (action === "install_hook") return "terminal";
  if (action === "install_skill") return "download";
  return "trash-2";
}

function memoryServiceEndpoint(): string {
  return typeof location === "undefined" ? "http://127.0.0.1:18960" : location.origin;
}

function formatProfilePaths(paths: string[]): string {
  return paths
    .map((path) => path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~"))
    .join(" / ");
}

async function waitForMemoryService(
  previousUptimeMs: number | undefined,
  requestedAt: number,
): Promise<boolean> {
  let observedDown = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    try {
      const result = await api.get<MemoryServiceHealth>("/api/v1/health");
      const expectedPreviousUptime = previousUptimeMs === undefined
        ? undefined
        : previousUptimeMs + Date.now() - requestedAt;
      if (
        result.ok !== false
        && (
          observedDown
          || (
            expectedPreviousUptime !== undefined
            && result.uptimeMs !== undefined
            && result.uptimeMs + 100 < expectedPreviousUptime
          )
        )
      ) return true;
    } catch {
      observedDown = true;
    }
  }
  return false;
}

// ─── General tab (merged Account + General) ─────────────────────────

function GeneralTab({
  telemetry,
  onPatchTelemetry,
}: {
  telemetry: NonNullable<ResolvedConfig["telemetry"]>;
  onPatchTelemetry: (
    p: Partial<NonNullable<ResolvedConfig["telemetry"]>>,
  ) => void;
}) {
  return (
    <div class="vstack" style="gap:var(--sp-4)">
      <section class="card">
        <div class="card__header" style="margin-bottom:var(--sp-3)">
          <h3 class="card__title">{t("settings.general.lang")}</h3>
        </div>
        <div class="segmented">
          <button
            class="segmented__item"
            aria-pressed={locale.value === "en"}
            onClick={() => setLocale("en")}
          >
            English
          </button>
          <button
            class="segmented__item"
            aria-pressed={locale.value === "zh"}
            onClick={() => setLocale("zh")}
          >
            中文
          </button>
        </div>
      </section>

      <section class="card">
        <div class="card__header" style="margin-bottom:var(--sp-3)">
          <h3 class="card__title">{t("settings.general.theme")}</h3>
        </div>
        <div class="segmented">
          {[
            { v: "auto" as const, k: "settings.general.theme.auto" as const, icon: "monitor" as const },
            { v: "light" as const, k: "settings.general.theme.light" as const, icon: "sun" as const },
            { v: "dark" as const, k: "settings.general.theme.dark" as const, icon: "moon" as const },
          ].map((opt) => (
            <button
              key={opt.v}
              class="segmented__item"
              aria-pressed={theme.value === opt.v}
              onClick={() => setTheme(opt.v)}
            >
              <Icon name={opt.icon} size={14} />
              {t(opt.k)}
            </button>
          ))}
        </div>
      </section>

      <section class="card">
        <div class="hstack" style="justify-content:space-between;margin-bottom:var(--sp-2)">
          <div>
            <h3 class="card__title">{t("settings.general.telemetry")}</h3>
            <p class="card__subtitle">{t("settings.general.telemetry.desc")}</p>
          </div>
          <ToggleSwitch
            checked={!!telemetry.enabled}
            onChange={(v) => onPatchTelemetry({ enabled: v })}
          />
        </div>
      </section>

      <AccountSection />

      {(health.value?.agent === "openclaw" || health.value?.agent === "hermes") && (
        <DangerZoneSection />
      )}
    </div>
  );
}

function AccountSection() {
  // Password protection is one-way (can't be disabled from settings —
  // only reset back to the initial setup screen). This section offers
  // two actions: "Logout" (keeps password, clears session) and
  // "Reset password" (deletes `.auth.json` then logs out, so the next
  // visit lands on the setup screen).
  const [status, setStatus] = useState<{ enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  useEffect(() => {
    api
      .get<{ enabled: boolean }>("/api/v1/auth/status")
      .then(setStatus)
      .catch(() => setStatus({ enabled: false }));
  }, []);

  const logout = async () => {
    setBusy(true);
    try { await api.post("/api/v1/auth/logout", {}); location.reload(); }
    finally { setBusy(false); }
  };

  const resetPassword = async () => {
    setBusy(true);
    try {
      await api.post("/api/v1/auth/reset", {});
      location.reload();
    } catch {
      setBusy(false);
      setConfirmingReset(false);
    }
  };

  if (!status?.enabled) return null;

  return (
    <>
      <section class="card">
        <div class="card__header">
          <div>
            <h3 class="card__title">{t("settings.account.protection")}</h3>
          </div>
        </div>
        {/*
         * Action order: reset-password on the LEFT (the routine
         * operator action), logout on the RIGHT (the terminal /
         * destructive one — visually anchored where the "primary
         * decisive" slot is). Mirrors the placement users expect from
         * Gmail-style "change password | sign out" rows.
         */}
        <div class="hstack" style="gap:var(--sp-3)">
          <button
            class="btn btn--ghost btn--sm"
            onClick={() => setConfirmingReset(true)}
            disabled={busy}
          >
            <Icon name="key-round" size={14} />
            {t("settings.account.resetPassword")}
          </button>
          <button class="btn btn--danger btn--sm" onClick={logout} disabled={busy}>
            <Icon name={busy ? "loader-2" : "log-out"} size={14} class={busy ? "spin" : ""} />
            {t("settings.account.logout")}
          </button>
        </div>
      </section>

      {confirmingReset && (
        <div
          class="modal-backdrop"
          onClick={() => { if (!busy) setConfirmingReset(false); }}
        >
          <div
            class="modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="modal__header">
              <div class="hstack" style="gap:var(--sp-2);align-items:center">
                <Icon name="key-round" size={18} style="color:var(--accent)" />
                <h3 class="modal__title" style="margin:0">
                  {t("settings.account.resetPassword")}
                </h3>
              </div>
            </div>
            <div class="modal__body">
              <p style="margin:0;font-size:var(--fs-sm);line-height:1.6">
                {t("settings.account.resetConfirm")}
              </p>
            </div>
            <div class="modal__footer">
              <button
                class="btn btn--ghost btn--sm"
                onClick={() => setConfirmingReset(false)}
                disabled={busy}
              >
                {t("common.cancel")}
              </button>
              <button
                class="btn btn--danger btn--sm"
                onClick={resetPassword}
                disabled={busy}
              >
                <Icon
                  name={busy ? "loader-2" : "refresh-cw"}
                  size={14}
                  class={busy ? "spin" : ""}
                />
                {t("settings.account.resetConfirmBtn")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function DangerZoneSection() {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  const clearAllData = async () => {
    setClearing(true);
    beginClearData();
    try {
      // The server wipes SQLite + cleanly tears down its core; the
      // next agent boot will recreate an empty DB. We don't try to
      // restart the agent process from here — the toast tells the
      // user to do it manually (see `stores/restart.ts` for why).
      const response = await api.post<ClearDataResponse>("/api/v1/admin/clear-data", {});
      setConfirming(false);
      setClearing(false);
      await triggerCleared(response);
    } catch {
      setClearing(false);
      setConfirming(false);
      markClearResultUnknown();
    }
  };

  return (
    <>
      <section class="card" style="border-color:var(--red)">
        <div class="card__header">
          <div>
            <h3 class="card__title" style="color:var(--red)">{t("settings.danger.title")}</h3>
            <p class="card__subtitle">{t("settings.danger.desc")}</p>
          </div>
        </div>
        <button class="btn btn--danger btn--sm" onClick={() => setConfirming(true)}>
          <Icon name="trash-2" size={14} />
          {t("settings.danger.clearAll")}
        </button>
      </section>

      {confirming && (
        <div
          class="modal-backdrop"
          onClick={() => { if (!clearing) setConfirming(false); }}
        >
          <div
            class="modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="modal__header">
              <div class="hstack" style="gap:var(--sp-2);align-items:center">
                <Icon name="circle-alert" size={18} style="color:var(--red)" />
                <h3 class="modal__title" style="color:var(--red);margin:0">
                  {t("settings.danger.clearAll")}
                </h3>
              </div>
            </div>
            <div class="modal__body">
              <p style="margin:0;font-size:var(--fs-sm);line-height:1.6">
                {t("settings.danger.confirm")}
              </p>
            </div>
            <div class="modal__footer">
              <button
                class="btn btn--ghost btn--sm"
                onClick={() => setConfirming(false)}
                disabled={clearing}
              >
                {t("common.cancel")}
              </button>
              <button
                class="btn btn--danger btn--sm"
                onClick={clearAllData}
                disabled={clearing}
              >
                <Icon
                  name={clearing ? "loader-2" : "trash-2"}
                  size={14}
                  class={clearing ? "spin" : ""}
                />
                {t("settings.danger.confirmBtn")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Small helpers ───────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: preact.ComponentChildren;
}) {
  return (
    <label style="display:flex;flex-direction:column;gap:6px">
      <span style="font-size:var(--fs-xs);color:var(--fg-muted);font-weight:var(--fw-med)">
        {label}
      </span>
      {children}
    </label>
  );
}

function ToggleSwitch({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={`
        position:relative;width:40px;height:22px;border-radius:999px;
        background:${checked ? "var(--accent)" : "var(--border-strong)"};
        border:none;cursor:${disabled ? "not-allowed" : "pointer"};
        opacity:${disabled ? "0.6" : "1"};
        transition:background var(--dur-xs),opacity var(--dur-xs);flex-shrink:0
      `}
    >
      <span
        aria-hidden="true"
        style={`
          position:absolute;left:${checked ? "20px" : "2px"};top:2px;
          width:18px;height:18px;border-radius:999px;background:#fff;
          transition:left var(--dur-xs) var(--ease-out);
          box-shadow:0 1px 3px rgba(0,0,0,0.25)
        `}
      />
    </button>
  );
}
