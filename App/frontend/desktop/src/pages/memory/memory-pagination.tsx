import { useEffect, useState } from "react";
import { useTranslation } from "../../i18n/use-translation.js";
import { ChevronLeft, ChevronRight } from "./memory-prototype-icons.js";

/** Contract for memory page info. */
export interface MemoryPageInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/** Contract for memory pagination props. */
export interface MemoryPaginationProps {
  data: MemoryPageInfo;
  onPageChange: (page: number) => void;
}

/** Handles memory pagination. */
export function MemoryPagination(props: MemoryPaginationProps) {
  const { t } = useTranslation();
  const totalPages = Math.max(1, normalizePage(props.data.totalPages));
  const currentPage = clampPage(props.data.page, totalPages);
  const [draftPage, setDraftPage] = useState(String(currentPage));

  useEffect(() => {
    setDraftPage(String(currentPage));
  }, [currentPage]);

  function commitDraftPage() {
    const nextPage = clampPage(Number.parseInt(draftPage, 10), totalPages);
    setDraftPage(String(nextPage));
    if (nextPage !== currentPage) {
      props.onPageChange(nextPage);
    }
  }

  function updateDraftPage(value: string) {
    if (value && !/^\d+$/.test(value)) {
      return;
    }
    if (!value) {
      setDraftPage("");
      return;
    }

    setDraftPage(String(clampPage(Number.parseInt(value, 10), totalPages)));
  }

  return (
    <nav className="memory-pagination" aria-label={t("memory.memories.paginationLabel")}>
      <div className="memory-pagination__controls">
        <button
          type="button"
          className="memory-pagination__button memory-pagination__button--icon"
          disabled={!props.data.hasPrev}
          onClick={() => props.onPageChange(currentPage - 1)}
          aria-label={t("memory.memories.previousPage")}
          title={t("memory.memories.previousPage")}
        >
          <ChevronLeft size={15} />
        </button>
        <div className="memory-pagination__summary" aria-label={t("memory.memories.pageSummary", { page: currentPage, totalPages })}>
          <span>{t("memory.memories.pagePrefix")}</span>
          <input
            className="memory-pagination__input"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={draftPage}
            aria-label={t("memory.memories.pageInputLabel")}
            onChange={(event) => updateDraftPage(event.target.value)}
            onBlur={commitDraftPage}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
                return;
              }
              if (event.key.length === 1 && !/^\d$/.test(event.key)) {
                event.preventDefault();
              }
            }}
          />
          <span>{t("memory.memories.pageTotal", { totalPages })}</span>
        </div>
        <button
          type="button"
          className="memory-pagination__button memory-pagination__button--icon"
          disabled={!props.data.hasNext}
          onClick={() => props.onPageChange(currentPage + 1)}
          aria-label={t("memory.memories.nextPage")}
          title={t("memory.memories.nextPage")}
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </nav>
  );
}

export function normalizePage(page: number | undefined): number {
  return Number.isFinite(page) && page! > 0 ? Math.floor(page!) : 1;
}

function clampPage(page: number, totalPages: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.floor(page), 1), totalPages);
}
