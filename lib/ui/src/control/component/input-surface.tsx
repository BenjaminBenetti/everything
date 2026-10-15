import { createElement, type ComponentProps } from "react";

/** Preserve native semantics when framing a field, a labeled input, or a composer form. */
type InputSurfaceProps =
  | (ComponentProps<"div"> & { as?: "div" })
  | (ComponentProps<"label"> & { as: "label" })
  | (ComponentProps<"form"> & { as: "form" });

/** Give composite text controls one shared outer border and focus indicator. */
export function InputSurface({
  as = "div",
  className = "",
  ...props
}: InputSurfaceProps) {
  return createElement(as, {
    ...props,
    className: `input-surface ${className}`,
  });
}
