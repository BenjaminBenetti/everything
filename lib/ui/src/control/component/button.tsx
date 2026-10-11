import type { ButtonHTMLAttributes } from "react";

/** Native button semantics with shared design roles. */
export function Button({
  className = "",
  variant = "primary",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "light" | "text";
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
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
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
