import type { ComponentProps } from "react";
import { Search } from "lucide-react";
import { InputSurface } from "./input-surface.js";

/** A labeled search control whose icon, padding, and input share one focus boundary. */
export function SearchInput({
  label,
  className = "",
  ...props
}: Omit<ComponentProps<"input">, "type" | "children" | "className"> & {
  label: string;
  className?: string;
}) {
  return (
    <InputSurface as="label" className={`search-input ${className}`}>
      <Search aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <input {...props} type="search" />
    </InputSurface>
  );
}
