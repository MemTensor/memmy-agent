/** Search palette module. */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Search } from "../pages/memory/memory-prototype-icons.js";
import type { AgentTaskView } from "../state/agent-chat-slice.js";

export interface SearchPaletteProps {
  open: boolean;
  tasks: AgentTaskView[];
  onClose: () => void;
  onSelectTask: (task: AgentTaskView) => void;
  placeholder?: string;
  emptyLabel?: string;
  untitledLabel?: string;
  ariaLabel?: string;
}

export function SearchPalette(props: SearchPaletteProps) {
  const { open, tasks, onClose, onSelectTask, placeholder, emptyLabel, untitledLabel, ariaLabel } = props;
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = filterTasks(tasks, query);
  const displayTasks = query.trim() ? filtered : tasks.slice(0, 12);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const handle = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [open, onClose]);

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, displayTasks.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const task = displayTasks[activeIndex];
      if (task) onSelectTask(task);
    }
  }

  return (
    <div className="search-palette-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="search-palette" role="dialog" aria-modal="true" aria-label={ariaLabel}>
        <div className="search-palette-input-row">
          <Search size={16} className="search-palette-icon" />
          <input
            ref={inputRef}
            type="text"
            className="search-palette-input"
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="search-palette-list" ref={listRef} role="listbox">
          {displayTasks.length === 0 && (
            <div className="search-palette-empty">{emptyLabel}</div>
          )}
          {displayTasks.map((task, i) => (
            <button
              key={task.sessionKey}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              className={`search-palette-item${i === activeIndex ? " search-palette-item--active" : ""}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => onSelectTask(task)}
            >
              <span className="search-palette-item-title">{task.title || untitledLabel}</span>
              {task.preview && <span className="search-palette-item-preview">{task.preview}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function filterTasks(tasks: AgentTaskView[], searchQuery: string): AgentTaskView[] {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter((task) => {
    const haystack = [task.title, task.preview, ...task.tags].join(" ").toLowerCase();
    return haystack.includes(q);
  });
}
