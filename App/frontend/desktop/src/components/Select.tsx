/** Select module. */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

/** Contract for select option. */
export interface SelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
  groupLabel?: string;
  disabled?: boolean;
}

/** Contract for select props. */
export interface SelectProps {
  id?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
  menuClassName?: string;
  labelClassName?: string;
}

/** Handles select. */
export function Select(props: SelectProps) {
  const generatedId = useId();
  const controlId = props.id ?? generatedId;
  const listboxId = `${controlId}-listbox`;
  const labelId = `${controlId}-label`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState(props.value);

  const enabledOptions = useMemo(() => props.options.filter((option) => !option.disabled), [props.options]);
  const selectedOption = props.options.find((option) => option.value === props.value);
  const activeOption = props.options.find((option) => option.value === activeValue && !option.disabled);

  useEffect(() => {
    if (!open) return;

    setActiveValue(props.value || enabledOptions[0]?.value || "");

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [enabledOptions, open, props.value]);

  function moveActive(step: 1 | -1) {
    if (!enabledOptions.length) return;

    const currentIndex = Math.max(
      0,
      enabledOptions.findIndex((option) => option.value === (activeOption?.value ?? props.value))
    );
    const nextIndex = (currentIndex + step + enabledOptions.length) % enabledOptions.length;
    const nextOption = enabledOptions[nextIndex];
    if (nextOption) {
      setActiveValue(nextOption.value);
    }
  }

  function selectValue(nextValue: string) {
    const nextOption = props.options.find((option) => option.value === nextValue);
    if (!nextOption || nextOption.disabled) return;

    props.onValueChange(nextValue);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (props.disabled) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      moveActive(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      moveActive(-1);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) {
        selectValue(activeOption?.value ?? props.value);
      } else {
        setOpen(true);
      }
    }
  }

  let previousGroupLabel: string | undefined;

  return (
    <div ref={rootRef} className={`select-control ${props.className ?? ""}`}>
      {props.label && (
        <span id={labelId} className={props.labelClassName ?? "select-control__label"}>
          {props.label}
        </span>
      )}
      {props.name && <input type="hidden" name={props.name} value={props.value} />}
      <button
        id={controlId}
        type="button"
        className={`select-control__button ${props.buttonClassName ?? ""}`}
        role="combobox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={props.label ? `${labelId} ${controlId}` : undefined}
        disabled={props.disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleKeyDown}
      >
        <span className="select-control__selection">
          {selectedOption?.icon && (
            <span className="select-control__option-icon" aria-hidden="true">{selectedOption.icon}</span>
          )}
          <span className={`select-control__value ${selectedOption ? "" : "select-control__value--placeholder"}`}>
            {selectedOption?.label ?? props.placeholder ?? ""}
          </span>
        </span>
        <ChevronDown size={16} strokeWidth={2.2} className="select-control__icon" aria-hidden="true" />
      </button>
      {open && (
        <div id={listboxId} className={`select-control__menu ${props.menuClassName ?? ""}`} role="listbox" aria-labelledby={props.label ? labelId : undefined}>
          {props.options.map((option) => {
            const showGroupLabel = Boolean(option.groupLabel && option.groupLabel !== previousGroupLabel);
            previousGroupLabel = option.groupLabel;

            return (
              <div key={option.value}>
                {showGroupLabel && <div className="select-control__group-label">{option.groupLabel}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === props.value}
                  disabled={option.disabled}
                  className={`select-control__option ${
                    option.value === props.value ? "select-control__option--selected" : ""
                  } ${option.value === activeValue ? "select-control__option--active" : ""}`}
                  onClick={() => selectValue(option.value)}
                >
                  <span className="select-control__option-content">
                    {option.icon && (
                      <span className="select-control__option-icon" aria-hidden="true">{option.icon}</span>
                    )}
                    <span className="select-control__option-label">{option.label}</span>
                  </span>
                  {option.value === props.value && <Check size={14} strokeWidth={2.6} aria-hidden="true" />}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
