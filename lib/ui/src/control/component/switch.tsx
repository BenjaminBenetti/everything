import { useId } from "react";

/** An on/off setting with native checkbox keyboard and form semantics, announced as a switch. */
export function Switch({
  label,
  description,
  checked,
  disabled = false,
  onChange,
  className = "",
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <label className={`switch ${className}`}>
      <span className="switch-text">
        <span className="switch-label" id={id + "-label"}>
          {label}
        </span>
        {description && (
          <span className="switch-description" id={id + "-description"}>
            {description}
          </span>
        )}
      </span>
      <input
        className="switch-input"
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        aria-labelledby={id + "-label"}
        aria-describedby={description ? id + "-description" : undefined}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </label>
  );
}
