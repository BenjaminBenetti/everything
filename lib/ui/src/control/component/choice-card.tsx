import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";

/** A fully styled selection card with native radio keyboard and screen-reader semantics. */
export function ChoiceCard({
  name,
  value,
  label,
  description,
  checked,
  onChange,
  children,
  className = "",
}: {
  name: string;
  value: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <label className={`choice-card ${className}`}>
      <input
        className="choice-card-input"
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        aria-labelledby={id + "-label"}
        aria-describedby={description ? id + "-description" : undefined}
      />
      <span className="choice-card-surface">
        {children}
        <span className="choice-card-label" id={id + "-label"}>
          {label}
          <span className="choice-card-check" aria-hidden="true">
            <Check />
          </span>
        </span>
        {description && (
          <span className="choice-card-description" id={id + "-description"}>
            {description}
          </span>
        )}
      </span>
    </label>
  );
}
