import * as Primitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import type { SelectOption } from "./select.js";

/** Multiple independent selections in the same themed dropdown family as Select. */
export interface MultiSelectProps {
  readonly label: string;
  readonly value: readonly string[];
  readonly options: readonly SelectOption[];
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly onValueChange: (value: string[]) => void;
}

/** Keep checkable options open while selecting; Radix owns focus, keyboard navigation, and dismissal. */
export function MultiSelect({
  label,
  value,
  options,
  placeholder,
  disabled = false,
  onValueChange,
}: MultiSelectProps) {
  const selected = options.filter((option) => value.includes(option.value));
  return (
    <Primitive.Root>
      <Primitive.Trigger
        className="select-trigger"
        aria-label={label}
        disabled={disabled}
        data-placeholder={selected.length ? undefined : ""}
      >
        <span className="select-value">
          {selected.length
            ? selected.map((option) => option.label).join(", ")
            : placeholder}
        </span>
        <ChevronDown className="select-chevron" aria-hidden="true" />
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          className="select-content multi-select-content"
          aria-label={label}
          align="start"
          sideOffset={6}
          collisionPadding={12}
        >
          {options.map((option) => (
            <Primitive.CheckboxItem
              key={option.value}
              className="select-option"
              textValue={option.label}
              checked={value.includes(option.value)}
              disabled={option.disabled ?? false}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                onValueChange(
                  checked
                    ? [
                        ...value.filter((item) => item !== option.value),
                        option.value,
                      ]
                    : value.filter((item) => item !== option.value),
                )
              }
            >
              <span className="select-option-label">
                {option.icon && (
                  <span className="select-option-icon" aria-hidden="true">
                    {option.icon}
                  </span>
                )}
                <span>{option.label}</span>
              </span>
              <Primitive.ItemIndicator className="select-indicator">
                <Check aria-hidden="true" />
              </Primitive.ItemIndicator>
            </Primitive.CheckboxItem>
          ))}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
