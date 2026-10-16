import { useId, useState, type ReactNode } from "react";

/** Describe a card icon on hover, keyboard focus, or touch without opening the app. */
export function ArtifactIndicator({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className="artifact-indicator"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement))
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <span
        className="artifact-indicator-icon"
        role="img"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        tabIndex={0}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
      >
        {children}
      </span>
      {open && (
        <span id={id} role="tooltip" className="artifact-tooltip">
          {description}
        </span>
      )}
    </span>
  );
}
