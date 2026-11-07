import { BookOpen, ListChecks, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { listKnowledgeBases, type KnowledgeBaseOption } from "../api/knowledge-bases-client.js";
import { Button } from "../components/button.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Modal } from "../components/modal.js";
import { useTranslation } from "../i18n/use-translation.js";
import styles from "./collab-knowledge-dialog.module.css";

/** Adds references only: source access still follows each knowledge base's sharing settings. */
export function ProjectKnowledgeDialog(props: {
  open: boolean;
  linked: Array<{ id: string; name: string }>;
  maxBases: number;
  config: RuntimeConfig | null;
  onClose: () => void;
  onAdd: (baseId: string) => Promise<void>;
  onAdded: (count: number) => void;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [options, setOptions] = useState<KnowledgeBaseOption[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Successful additions stay linked locally even if a later request fails or the parent has not refreshed yet.
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linkedIds = useMemo(() => new Set([...props.linked.map((base) => base.id), ...addedIds]), [props.linked, addedIds]);

  useEffect(() => {
    if (!props.open) return;
    setQuery("");
    setSelected(new Set());
    setAddedIds(new Set());
    setError(null);
    if (!props.config) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    setOptions(null);
    void listKnowledgeBases(props.config).then((bases) => {
      if (!cancelled) setOptions(bases);
    });
    return () => { cancelled = true; };
  }, [props.open, props.config]);

  const remaining = Math.max(0, props.maxBases - linkedIds.size);
  const picked = [...selected].filter((id) => !linkedIds.has(id));
  const capacityLeft = Math.max(0, remaining - picked.length);
  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (options ?? []).filter((base) => !keyword || base.name.toLowerCase().includes(keyword));
  }, [options, query]);

  function toggle(id: string) {
    if (saving || linkedIds.has(id)) return;
    setSelected((current) => {
      const next = new Set([...current].filter((key) => !linkedIds.has(key)));
      if (next.has(id)) next.delete(id);
      else if (next.size < remaining) next.add(id);
      return next;
    });
  }

  async function add() {
    if (saving || !picked.length || picked.length > remaining) return;
    setSaving(true);
    setError(null);
    const completed: string[] = [];
    try {
      for (const baseId of picked) {
        await props.onAdd(baseId);
        completed.push(baseId);
      }
      props.onAdded(completed.length);
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("collab.knowledge.addFailed"));
      if (completed.length > 0) {
        setAddedIds((current) => new Set([...current, ...completed]));
        setSelected((current) => new Set([...current].filter((id) => !completed.includes(id))));
        props.onAdded(completed.length);
      }
    } finally {
      setSaving(false);
    }
  }

  function detail(base: KnowledgeBaseOption): string | null {
    if (base.shared && base.sharedByMe === false) {
      return base.ownerName
        ? t("collab.knowledge.fromOwner", { name: base.ownerName })
        : t("collab.knowledge.sharedWithMe");
    }
    if (base.sharedByMe) return t("collab.knowledge.sharedByMe");
    if (base.shared === false) return t("collab.knowledge.personal");
    return null;
  }

  return (
    <Modal
      open={props.open}
      title={t("collab.knowledge.title")}
      onClose={() => { if (!saving) props.onClose(); }}
      showCloseButton
      closeDisabled={saving}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      initialFocusRef={searchRef}
      ariaDescribedBy={hintId}
      className={styles.dialog}
      backdropClassName={styles.backdrop}
      bodyClassName={styles.body}
      footerClassName={styles.footer}
      footer={(
        <>
          <span className={styles.capacity}>{t("collab.knowledge.remaining", { count: String(capacityLeft) })}</span>
          <span className={styles.actions}>
            <Button disabled={saving} onClick={props.onClose}>{t("collab.cancel")}</Button>
            <Button variant="primary" disabled={saving || !picked.length || picked.length > remaining} onClick={() => void add()}>
              {saving ? t("collab.knowledge.adding") : t("collab.knowledge.add")}
            </Button>
          </span>
        </>
      )}
    >
      <p id={hintId} className={styles.hint}>{t("collab.knowledge.hint")}</p>
      <label className={styles.search}>
        <Search size={16} aria-hidden="true" />
        <input ref={searchRef} type="search" value={query} placeholder={t("collab.knowledge.search")} aria-label={t("collab.knowledge.search")} disabled={saving} onChange={(event) => setQuery(event.target.value)} />
        {query ? <button type="button" className={styles.clearSearch} disabled={saving} aria-label={t("collab.knowledge.clearSearch")} onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X size={14} aria-hidden="true" /></button> : null}
      </label>
      <div className={styles.summary} role="status" aria-live="polite">
        {t("collab.knowledge.selected", { count: String(picked.length) })}
      </div>
      <div className={styles.results} aria-busy={options === null || saving}>
        {options === null ? (
          <div className={styles.empty} role="status">{t("collab.knowledge.loading")}</div>
        ) : visible.length === 0 ? (
          <div className={styles.empty}>
            {query.trim() ? <Search size={24} aria-hidden="true" /> : <BookOpen size={24} aria-hidden="true" />}
            <span>{t(query.trim() ? "collab.knowledge.noResults" : "collab.knowledge.empty")}</span>
            {query.trim() ? <small>{t("collab.knowledge.searchHelp")}</small> : null}
          </div>
        ) : (
          <ul className={styles.list}>
            {visible.map((base) => {
              const linked = linkedIds.has(base.id);
              const checked = !linked && selected.has(base.id);
              const disabled = saving || linked || (!checked && picked.length >= remaining);
              const metadata = detail(base);
              return (
                <li key={base.id}>
                  <label className={styles.row} data-selected={checked} data-disabled={disabled} data-linked={linked}>
                    <input type="checkbox" className={styles.checkbox} checked={linked || checked} disabled={disabled} aria-label={base.name} onChange={() => toggle(base.id)} />
                    <span className={styles.icon}><BookOpen size={19} aria-hidden="true" /></span>
                    <span className={styles.text}>
                      <span className={styles.name} title={base.name}>{base.name}</span>
                      {metadata ? <span className={styles.detail}>{metadata}</span> : null}
                    </span>
                    {linked ? <span className={styles.linked}>{t("collab.knowledge.linked")}</span> : null}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {error ? <span className={styles.error} role="alert">{error}</span> : null}
    </Modal>
  );
}

/** Manage every linked base, including bases unavailable in the current user's personal list. */
export function ProjectKnowledgeManageDialog(props: {
  open: boolean;
  knowledge: import("../api/collab-client.js").CollabKnowledgeView | null;
  onClose: () => void;
  onAdd: () => void;
  onRemove: (baseId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (props.open) { setQuery(""); setError(null); setSelecting(false); setSelected(new Set()); setConfirmOpen(false); }
  }, [props.open]);
  const bases = props.knowledge?.bases ?? [];
  const visible = bases.filter((base) => base.name.toLowerCase().includes(query.trim().toLowerCase()));
  const canRemove = (base: (typeof bases)[number]) => base.mine || Boolean(props.knowledge?.canManage);
  const visibleSelectable = visible.filter(canRemove);
  const allVisibleSelected = visibleSelectable.length > 0 && visibleSelectable.every((base) => selected.has(base.id));

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = visibleSelectable.every((base) => current.has(base.id));
      for (const base of visibleSelectable) {
        if (allSelected) next.delete(base.id); else next.add(base.id);
      }
      return next;
    });
  }

  async function remove(ids: string[]) {
    if (removing || ids.length === 0) return;
    setConfirmOpen(false);
    setRemoving(true);
    setError(null);
    const failed: string[] = [];
    let failureMessage = "";
    for (const id of ids) {
      try {
        await props.onRemove(id);
      } catch (cause) {
        failed.push(id);
        if (cause instanceof Error && cause.message) failureMessage = cause.message;
      }
    }
    if (ids.length === 1 && failed.length) {
      setError(failureMessage || t("collab.knowledge.removeFailed"));
    } else if (failed.length) {
      setError(t("collab.knowledge.removePartial", { removed: String(ids.length - failed.length), failed: String(failed.length) }));
    }
    if (selecting) {
      setSelected(new Set(failed));
      if (!failed.length) setSelecting(false);
    }
    setRemoving(false);
  }

  return (
    <>
      <Modal open={props.open && !confirmOpen} title={t("collab.knowledge.manageTitle")}
        subtitle={t("collab.knowledge.linkedCount", { count: String(bases.length) })}
        onClose={() => { if (!removing) props.onClose(); }} closeDisabled={removing}
        closeLabel={t("common.close")} closeContent={<X size={16} aria-hidden="true" />}
        className={`${styles.dialog} ${styles.manageDialog}`} backdropClassName={styles.backdrop}
        bodyClassName={styles.body}
      >
        <div className={styles.manageTools}>
          <label className={styles.search}>
            <Search size={16} aria-hidden="true" />
            <input type="search" value={query} placeholder={t("collab.knowledge.search")}
              aria-label={t("collab.knowledge.search")} disabled={removing} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <Button variant="secondary" size="sm" disabled={removing || selecting} onClick={props.onAdd}><Plus size={14} aria-hidden="true" />{t("collab.knowledge.add")}</Button>
        </div>
        {selecting ? (
          <div className={styles.manageSelectionBar}>
            <span className={styles.manageSelectionCount}>{t("collab.sessions.selectedCount", { count: String(selected.size) })}</span>
            <Button variant="ghost" size="sm" disabled={!visibleSelectable.length || removing} onClick={toggleAllVisible}>
              {t(allVisibleSelected ? "collab.knowledge.deselectVisible" : "collab.knowledge.selectVisible")}
            </Button>
            <Button variant="ghost" size="sm" disabled={removing} onClick={() => { setSelecting(false); setSelected(new Set()); setError(null); }}>{t("collab.cancel")}</Button>
            <Button variant="ghost" size="sm" className={styles.manageBulkRemove} disabled={!selected.size || removing} onClick={() => setConfirmOpen(true)}>
              <Trash2 size={14} aria-hidden="true" />{removing ? t("collab.knowledge.removing") : t("collab.knowledge.unlink")}
            </Button>
          </div>
        ) : bases.some(canRemove) ? (
          <div className={styles.manageSelectionBar}>
            <Button variant="ghost" size="sm" disabled={removing} onClick={() => { setError(null); setSelecting(true); }}>
              <ListChecks size={14} aria-hidden="true" />{t("collab.sessions.select")}
            </Button>
          </div>
        ) : null}
        <div className={styles.manageResults}>
          {visible.length ? (
            <ul className={styles.list}>
              {visible.map((base) => (
                <li key={base.id} className={`${styles.manageRow} ${selecting && selected.has(base.id) ? styles.manageRowSelected : ""}`}>
                  {selecting && canRemove(base) ? (
                    <label className={styles.manageSelectable}>
                      <input type="checkbox" className={styles.checkbox} checked={selected.has(base.id)} disabled={removing} aria-label={base.name} onChange={() => toggle(base.id)} />
                      <BookOpen size={17} aria-hidden="true" />
                      <span className={styles.manageName} title={base.name}>{base.name}</span>
                    </label>
                  ) : (
                    <><BookOpen size={17} aria-hidden="true" /><span className={styles.manageName} title={base.name}>{base.name}</span></>
                  )}
                  {!selecting && canRemove(base) ? (
                    <button type="button" className={styles.manageRemove} disabled={removing}
                      aria-label={t("collab.knowledge.remove", { name: base.name })} onClick={() => void remove([base.id])}>
                      {t("collab.knowledge.unlink")}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : <div className={styles.empty}>{t(query.trim() ? "collab.knowledge.noResults" : "collab.config.knowledgeEmpty")}</div>}
        </div>
        {error ? <span className={styles.error} role="alert">{error}</span> : null}
      </Modal>
      <ConfirmDialog open={props.open && confirmOpen} title={t("collab.knowledge.bulkRemoveTitle")}
        message={t("collab.knowledge.bulkRemoveMessage", { count: String(selected.size) })}
        cancelLabel={t("collab.cancel")} confirmLabel={t("collab.knowledge.unlink")} confirmVariant="danger"
        icon={null} onCancel={() => setConfirmOpen(false)} onConfirm={() => void remove([...selected])} />
    </>
  );
}
