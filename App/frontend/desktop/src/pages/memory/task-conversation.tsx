import { usePanelPoll } from "./use-panel-poll.js";
import { isUnsupportedPanelRoute } from "../../api/memory-runtime-client.js";
import { useLayoutEffect, useRef, useState } from "react";
import type { PanelTaskDetailOutput, PanelTaskFieldInput, PanelToolSummary } from "@memmy/local-api-contracts";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { toErrorMessage } from "./remote-state.js";
import { MemoryStateBox } from "./memory-state-box.js";

/** The parent keys this component by task and request generation. */
export function TaskConversation(props: { client: MemoryRuntimeClient; initial: PanelTaskDetailOutput }) {
  const { t } = useTranslation();
  const [data, setData] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const controller = useRef(new AbortController());
  const container = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ element: Element; top: number } | undefined>(undefined);
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    controller.current = new AbortController();
    return () => {
      active.current = false;
      controller.current.abort();
    };
  }, []);
  useLayoutEffect(() => {
    const saved = anchor.current;
    if (!saved) return;
    const drawer = container.current?.closest(".memory-drawer__body");
    if (drawer) drawer.scrollTop += saved.element.getBoundingClientRect().top - saved.top;
    anchor.current = undefined;
  }, [data]);
  const [supportsCheck, setSupportsCheck] = useState(true);
  usePanelPoll(Boolean(props.client.checkPanelTask) && supportsCheck, async () => {
    try {
      const result = await props.client.checkPanelTask!(data.task.id, controller.current.signal);
      if (active.current && result.latestTurnId) {
        setData((current) => ({
          ...current,
          hasNewer: !current.turns.some((turn) => turn.rawTurnId === result.latestTurnId)
        }));
      }
    } catch (error) {
      if (isUnsupportedPanelRoute(error)) {
        setSupportsCheck(false);
        return;
      }
      throw error;
    }
  });
  async function load(earlier: boolean) {
    if (busy || !props.client.getPanelTaskDetail) return;
    setBusy(true);
    setError(undefined);
    try {
      const page = await props.client.getPanelTaskDetail(
        data.task.id,
        earlier ? data.nextCursor : undefined,
        controller.current.signal
      );
      if (!active.current) return;
      if (!earlier) setRevision((value) => value + 1);
      const element = container.current?.querySelector("[data-turn-id]");
      if (earlier && element) anchor.current = { element, top: element.getBoundingClientRect().top };
      setData((current) => ({
        ...page,
        turns: earlier
          ? [
              ...page.turns.filter((turn) => !current.turns.some((old) => old.rawTurnId === turn.rawTurnId)),
              ...current.turns
            ]
          : page.turns
      }));
    } catch (error) {
      if (active.current) setError(toErrorMessage(error));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <div ref={container}>
      {data.nextCursor && (
        <button type="button" disabled={busy} onClick={() => void load(true)}>
          {t("memory.tasks.loadEarlier")}
        </button>
      )}
      <button type="button" disabled={busy} onClick={() => void load(false)}>
        {t(data.hasNewer ? "memory.tasks.newMessages" : "memory.tasks.reloadConversation")}
      </button>
      {busy && <MemoryStateBox message={t("common.loading")} />}
      {error && <MemoryStateBox message={error} tone="error" />}
      {data.turns.map((turn) => (
        <section className="memory-detail-card" data-turn-id={turn.rawTurnId} key={`${turn.rawTurnId}:${revision}`}>
          <time>{turn.createdAt}</time>
          <TurnTools
            client={props.client}
            taskId={data.task.id}
            turnId={turn.rawTurnId}
            initial={turn.tools ?? []}
            calls={turn.toolCallCount}
            results={turn.toolResultCount}
          />
          {(["userText", "assistantText", "reasoningSummary"] as const).map((field) => {
            const preview = turn[field];
            const more = turn.moreFields.includes(field);
            return preview || more ? (
              <TurnField
                key={field}
                client={props.client}
                taskId={data.task.id}
                turnId={turn.rawTurnId}
                field={field}
                preview={preview}
                more={more}
              />
            ) : null;
          })}
        </section>
      ))}
      {!data.turns.length && <MemoryStateBox message={t("memory.tasks.noConversation")} />}
    </div>
  );
}

function TurnField(props: {
  client: MemoryRuntimeClient;
  taskId: string;
  turnId: string;
  field: PanelTaskFieldInput["field"];
  toolId?: string;
  preview?: string;
  more: boolean;
}) {
  const { t } = useTranslation();
  const [content, setContent] = useState<string>();
  const [next, setNext] = useState<number>();
  const [revision, setRevision] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef(true);
  const controller = useRef(new AbortController());
  useLayoutEffect(() => {
    active.current = true;
    controller.current = new AbortController();
    return () => {
      active.current = false;
      controller.current.abort();
    };
  }, []);
  async function load() {
    if (!props.client.getPanelTaskField || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const page = await props.client.getPanelTaskField(
        props.taskId,
        props.turnId,
        { field: props.field, toolId: props.toolId, offset: next, revision },
        controller.current.signal
      );
      if (!active.current) return;
      setContent((current) => (next ? (current ?? "") : "") + page.text);
      setNext(page.nextOffset);
      setRevision(page.revision);
    } catch (error) {
      if (active.current) {
        setError(toErrorMessage(error));
        setContent(undefined);
        setNext(undefined);
        setRevision(undefined);
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <div>
      <h6>{t(`memory.tasks.field.${props.field}`)}</h6>
      <pre className="memory-detail-text" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {content ?? props.preview}
      </pre>
      {props.more && (content === undefined || next !== undefined) && (
        <button type="button" disabled={busy} onClick={() => void load()}>
          {t(busy ? "common.loading" : "memory.tasks.loadContent")}
        </button>
      )}
      {error && <MemoryStateBox message={error} tone="error" />}
    </div>
  );
}

function TurnTools(props: {
  client: MemoryRuntimeClient;
  taskId: string;
  turnId: string;
  initial: PanelToolSummary[];
  calls: number;
  results: number;
}) {
  const { t } = useTranslation();
  const [tools, setTools] = useState(props.initial);
  const [open, setOpen] = useState(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef(true);
  const controller = useRef(new AbortController());
  useLayoutEffect(() => {
    active.current = true;
    controller.current = new AbortController();
    return () => {
      active.current = false;
      controller.current.abort();
    };
  }, []);
  async function load(field: "toolCalls" | "toolResults") {
    if (busy || !props.client.getPanelTaskField) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await props.client.getPanelTaskField(
        props.taskId,
        props.turnId,
        { field, offset: tools.filter((tool) => tool.field === field).length },
        controller.current.signal
      );
      if (active.current)
        setTools((current) => [
          ...current,
          ...(result.tools ?? []).filter(
            (tool) => !current.some((old) => old.id === tool.id && old.field === tool.field)
          )
        ]);
    } catch (error) {
      if (active.current) setError(toErrorMessage(error));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <>
      {tools.map((tool) => {
        const key = `${tool.field}:${tool.id}`;
        return (
          <div key={key}>
            <button
              type="button"
              onClick={() =>
                setOpen((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            >
              {tool.name} ({tool.characters.toLocaleString()})
            </button>
            {open.has(key) && (
              <TurnField
                client={props.client}
                taskId={props.taskId}
                turnId={props.turnId}
                field={tool.field}
                toolId={tool.id}
                more
              />
            )}
          </div>
        );
      })}
      {(["toolCalls", "toolResults"] as const).map(
        (field) =>
          tools.filter((tool) => tool.field === field).length <
            (field === "toolCalls" ? props.calls : props.results) && (
            <button key={field} type="button" disabled={busy} onClick={() => void load(field)}>
              {t("memory.tasks.loadContent")} · {t(`memory.tasks.field.${field}`)}
            </button>
          )
      )}
      {error && <MemoryStateBox tone="error" message={error} />}
    </>
  );
}
