import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { Icon } from "./Icon";

export interface SelectOption {
  value: string;
  label: string;
  title?: string;
  icon?: ComponentChildren;
}

interface SelectProps {
  value: string | number;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  width?: "full" | "auto";
  placement?: "bottom" | "top";
}

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className = "",
  width = "full",
  placement = "bottom",
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedValue = String(value);
  const selected = options.find((option) => option.value === selectedValue) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div
      ref={rootRef}
      class={`custom-select${width === "auto" ? " custom-select--auto" : ""}`}
    >
      <button
        type="button"
        class={`select custom-select__trigger${open ? " custom-select__trigger--open" : ""}${className ? ` ${className}` : ""}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {selected?.icon && <span class="custom-select__option-icon">{selected.icon}</span>}
        <span class="custom-select__value">{selected?.label ?? ""}</span>
        <Icon name="chevron-down" size={14} class={`custom-select__chevron${open ? " custom-select__chevron--open" : ""}`} />
      </button>

      {open && (
        <div
          class={`custom-select__menu${placement === "top" ? " custom-select__menu--top" : ""}`}
          role="listbox"
          aria-label={ariaLabel}
        >
          {options.map((option) => {
            const selectedOption = option.value === selectedValue;
            return (
              <button
                type="button"
                class={`custom-select__option${selectedOption ? " custom-select__option--selected" : ""}`}
                role="option"
                aria-selected={selectedOption}
                title={option.title}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span class="custom-select__option-content">
                  {option.icon && <span class="custom-select__option-icon">{option.icon}</span>}
                  <span>{option.label}</span>
                </span>
                {selectedOption && <Icon name="check" size={14} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
