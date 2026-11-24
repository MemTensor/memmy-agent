import { useRef } from "react";
import { Search, X } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import "./search-field.css";

/** Shared search control for the tools catalog and recording list. */
export function SearchField(props: { className?: string; label: string; value: string; onChange(value: string): void }) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const clear = () => { props.onChange(""); inputRef.current?.focus(); };
  return <div className={`search-field ${props.className ?? ""}`}>
    <Search size={15} aria-hidden="true" />
    <input ref={inputRef} type="search" aria-label={props.label} placeholder={props.label} value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape") clear(); }} />
    {props.value ? <button type="button" className="search-field__clear" aria-label={t("common.clearSearch")}
      onClick={clear}><X size={14} aria-hidden="true" /></button> : null}
  </div>;
}
