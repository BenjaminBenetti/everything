import type { ButtonHTMLAttributes } from "react";

/** Shared profile control with a consistent appearance, focus ring, and touch target. */
export function AvatarButton({
  name,
  label,
  className = "",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  name: string;
  label: string;
}) {
  return (
    <button
      {...props}
      type="button"
      className={"avatar-button " + className}
      aria-label={label}
      title={label}
    >
      <span aria-hidden="true">
        {Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "Y"}
      </span>
    </button>
  );
}
