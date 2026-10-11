import type { ComponentProps } from "react";

/** Native button semantics with shared action and danger styles. */
export function Button({
  className = "",
  variant = "primary",
  type = "button",
  ...props
}: ComponentProps<"button"> & {
  variant?: "primary" | "light" | "text" | "danger" | "danger-quiet";
}) {
  return (
    <button
      type={type}
      className={`button ${variant} ${className}`}
      {...props}
    />
  );
}

/** A labeled icon control with a consistent keyboard and touch target. */
export function IconButton({
  label,
  className = "",
  type = "button",
  ...props
}: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`icon-button ${className}`}
      {...props}
    />
  );
}
