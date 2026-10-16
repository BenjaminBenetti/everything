import * as Primitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";

export { MultiSelect } from "./multi-select.js";

// ===========================================
// Public contracts
// ===========================================

/** A selectable value with readable text, optional artwork, and an optional unavailable state. */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
}

/** Controlled selection with a required accessible name and optional field associations. */
export interface SelectProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly id?: string;
  readonly describedBy?: string;
  readonly onValueChange: (value: string) => void;
}

// ===========================================
// Shared dropdown
// ===========================================

// Radix reserves empty strings for placeholders. Prefix every option to support a selectable empty value.
const optionPrefix = "option:";

/** Render a themed dropdown with accessible required state, keyboard navigation, and viewport-aware placement. */
export function Select({
  label,
  value,
  options,
  placeholder,
  disabled = false,
  required = false,
  id,
  describedBy,
  onValueChange,
}: SelectProps) {
  /** Ignore transient form-bridge resets while dependent options update; an explicit empty option still clears the value. */
  function changeValue(selected: string): void {
    if (!selected.startsWith(optionPrefix)) return;
    const next = selected.slice(optionPrefix.length);
    if (next !== value) onValueChange(next);
  }

  return (
    <Primitive.Root
      value={value ? `${optionPrefix}${value}` : ""}
      onValueChange={changeValue}
      disabled={disabled}
      required={required}
    >
      <Primitive.Trigger
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        className="select-trigger"
      >
        <span className="select-value">
          <Primitive.Value placeholder={placeholder} />
        </span>
        <Primitive.Icon asChild>
          <ChevronDown className="select-chevron" aria-hidden="true" />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          className="select-content"
          aria-label={label}
          position="popper"
          sideOffset={6}
          collisionPadding={12}
        >
          <Primitive.ScrollUpButton
            className="select-scroll"
            aria-hidden="true"
          >
            <ChevronUp />
          </Primitive.ScrollUpButton>
          <Primitive.Viewport className="select-viewport">
            {options.map((option) => (
              <Primitive.Item
                key={option.value}
                value={`${optionPrefix}${option.value}`}
                textValue={option.label}
                disabled={option.disabled ?? false}
                className="select-option"
                data-empty={option.value === "" ? "" : undefined}
              >
                <Primitive.ItemText>
                  {option.icon ? (
                    <span className="select-option-label">
                      <span className="select-option-icon" aria-hidden="true">
                        {option.icon}
                      </span>
                      <span>{option.label}</span>
                    </span>
                  ) : (
                    option.label
                  )}
                </Primitive.ItemText>
                <Primitive.ItemIndicator className="select-indicator">
                  <Check aria-hidden="true" />
                </Primitive.ItemIndicator>
              </Primitive.Item>
            ))}
          </Primitive.Viewport>
          <Primitive.ScrollDownButton
            className="select-scroll"
            aria-hidden="true"
          >
            <ChevronDown />
          </Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
