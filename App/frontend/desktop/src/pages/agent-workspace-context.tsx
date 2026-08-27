import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Check,
  GitBranch,
  GitFork,
  Laptop,
  Plus,
  Search,
} from "lucide-react";
import type {
  WorkspaceEnvironmentSnapshot,
} from "../api/memmy-agent-client.js";
import { useTranslation } from "../i18n/use-translation.js";

export type AgentWorkspaceContextProps = {
  snapshot: WorkspaceEnvironmentSnapshot | null;
  branches: string[];
  loading: boolean;
  error: string | null;
  onSwitchBranch: (branch: string) => Promise<boolean>;
  onCreateOrCheckoutBranch: (branch: string) => Promise<boolean>;
};

const DEFAULT_VISIBLE_BRANCH_COUNT = 5;

export function AgentWorkspaceContext({
  snapshot,
  branches,
  loading,
  error,
  onSwitchBranch,
  onCreateOrCheckoutBranch,
}: AgentWorkspaceContextProps) {
  const { t } = useTranslation();
  const [openMenu, setOpenMenu] = useState<"mode" | "branch" | null>(null);
  const [query, setQuery] = useState("");
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const branchSearchRef = useRef<HTMLInputElement | null>(null);
  const newBranchRef = useRef<HTMLInputElement | null>(null);
  const createBranchActionRef = useRef<HTMLButtonElement | null>(null);
  const restoreCreateActionFocusRef = useRef(false);
  const repository = snapshot?.status === "ready" ? snapshot.repository : null;
  const revision = repository?.branch
    ?? (repository?.head_sha ? `HEAD ${repository.head_sha.slice(0, 7)}` : null);
  const currentBranch = snapshot?.repository?.branch ?? null;
  const filteredBranches = branches.filter((branch) => branch.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  useEffect(() => {
    if (!openMenu) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenu(null);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  useEffect(() => {
    if (openMenu !== "branch") return;
    setQuery("");
    setCreateBranchOpen(false);
    setNewBranchName("");
    branchSearchRef.current?.focus();
  }, [openMenu]);

  useEffect(() => {
    if (createBranchOpen) newBranchRef.current?.focus();
  }, [createBranchOpen]);

  useEffect(() => {
    if (createBranchOpen || !restoreCreateActionFocusRef.current) return;
    restoreCreateActionFocusRef.current = false;
    createBranchActionRef.current?.focus();
  }, [createBranchOpen]);

  if (!revision) return null;

  const localLabel = t("home.environment.local");
  const branchLabel = currentBranch
    ? t("home.environment.branch.label", { branch: revision })
    : t("home.environment.detachedHead");

  function confirmDirtyWorkspace(): boolean {
    return snapshot?.repository?.worktree !== "dirty"
      || window.confirm(t("home.environment.branch.dirtyConfirm"));
  }

  async function selectBranch(branch: string) {
    if (branch === currentBranch) {
      setOpenMenu(null);
      return;
    }
    if (!confirmDirtyWorkspace()) return;
    if (await onSwitchBranch(branch)) setOpenMenu(null);
  }

  async function createOrCheckoutBranch() {
    const branch = newBranchName.trim();
    if (!branch || !confirmDirtyWorkspace()) return;
    if (await onCreateOrCheckoutBranch(branch)) {
      setCreateBranchOpen(false);
      setNewBranchName("");
      setOpenMenu(null);
    }
  }

  return (
    <div ref={rootRef} className="home-workspace-context" aria-label={t("home.environment.gitWorkspace")}>
      <div className="home-workspace-context__control">
        <button
          type="button"
          className={`home-workspace-context__trigger home-workspace-context__mode${openMenu === "mode" ? " home-workspace-context__trigger--open" : ""}`}
          aria-expanded={openMenu === "mode"}
          aria-haspopup="menu"
          onClick={() => setOpenMenu((current) => current === "mode" ? null : "mode")}
        >
          <Laptop size={14} aria-hidden="true" />
          <span>{localLabel}</span>
        </button>
        {openMenu === "mode" ? (
          <div className="home-workspace-menu home-workspace-menu--mode" role="menu">
            <button type="button" className="home-workspace-menu__item" role="menuitemradio" aria-checked="true" onClick={() => setOpenMenu(null)}>
              <Laptop size={17} aria-hidden="true" />
              <span>{localLabel}</span>
              <Check size={17} aria-hidden="true" />
            </button>
            <button type="button" className="home-workspace-menu__item" role="menuitem" disabled title={t("home.environment.mode.newWorktreeUnavailable")}>
              <GitFork size={17} aria-hidden="true" />
              <span>{t("home.environment.mode.newWorktree")}</span>
            </button>
          </div>
        ) : null}
      </div>

      <div className="home-workspace-context__control">
        <button
          type="button"
          className={`home-workspace-context__trigger home-workspace-context__branch${openMenu === "branch" ? " home-workspace-context__trigger--open" : ""}`}
          aria-expanded={openMenu === "branch"}
          aria-haspopup="listbox"
          title={branchLabel}
          disabled={loading || !currentBranch}
          onClick={() => setOpenMenu((current) => current === "branch" ? null : "branch")}
        >
          <GitBranch size={14} aria-hidden="true" />
          <span>{revision}</span>
        </button>
        {openMenu === "branch" ? (
          <div className="home-workspace-menu home-workspace-menu--branch">
            <label className="home-workspace-menu__search">
              <Search size={16} aria-hidden="true" />
              <input
                ref={branchSearchRef}
                value={query}
                placeholder={t("home.environment.branch.search", {
                  repository: snapshot?.repository?.display_name ?? t("home.environment.branch.repositoryFallback"),
                })}
                aria-label={t("home.environment.branch.searchAria")}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div
              className="home-workspace-menu__branch-list"
              role="listbox"
              aria-label={t("home.environment.branch.localList")}
              style={{ "--visible-branch-count": DEFAULT_VISIBLE_BRANCH_COUNT } as CSSProperties}
            >
              {filteredBranches.length ? filteredBranches.map((branch) => (
                <button
                  key={branch}
                  type="button"
                  className="home-workspace-menu__item home-workspace-menu__branch-item"
                  role="option"
                  aria-selected={branch === currentBranch}
                  onClick={() => void selectBranch(branch)}
                >
                  <GitBranch size={16} aria-hidden="true" />
                  <span title={branch}>{branch}</span>
                  {branch === currentBranch ? <Check size={17} aria-hidden="true" /> : null}
                </button>
              )) : <p className="home-workspace-menu__empty">{t("home.environment.branch.empty")}</p>}
            </div>
            {error ? <p className="home-workspace-menu__error" role="status">{error}</p> : null}
            {createBranchOpen ? (
              <form
                className="home-workspace-menu__branch-create-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createOrCheckoutBranch();
                }}
              >
                <p className="home-workspace-menu__branch-create-base">
                  {t("home.environment.branch.createFrom", { branch: currentBranch ?? revision })}
                </p>
                <input
                  ref={newBranchRef}
                  value={newBranchName}
                  maxLength={250}
                  aria-label={t("home.environment.branch.newNameAria")}
                  placeholder={t("home.environment.branch.newNamePlaceholder")}
                  disabled={loading}
                  onChange={(event) => setNewBranchName(event.target.value)}
                />
                <div className="home-workspace-menu__branch-create-actions">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      restoreCreateActionFocusRef.current = true;
                      setCreateBranchOpen(false);
                      setNewBranchName("");
                    }}
                  >
                    {t("home.environment.branch.cancelCreate")}
                  </button>
                  <button type="submit" disabled={loading || !newBranchName.trim()}>
                    {t("home.environment.branch.confirmCreate")}
                  </button>
                </div>
              </form>
            ) : null}
            {!createBranchOpen ? <div className="home-workspace-menu__branch-footer">
              <button
                ref={createBranchActionRef}
                type="button"
                className="home-workspace-menu__branch-create"
                aria-expanded={createBranchOpen}
                onClick={() => setCreateBranchOpen(true)}
              >
                <Plus size={17} aria-hidden="true" />
                <span>{t("home.environment.branch.createOrCheckout")}</span>
              </button>
            </div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
