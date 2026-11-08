/** A line of a field's text: where its top and bottom lie in the field's scrolled contents. */
export interface TextLine {
  readonly top: number;
  readonly bottom: number;
}

/** What a scrolling field shows of its contents, and the padding around its text. */
export interface FieldView {
  readonly scrollTop: number;
  /** The visible height, padding included. */
  readonly height: number;
  readonly paddingTop: number;
  readonly paddingBottom: number;
}

/**
 * The text that places the line `position` is on: everything before it and the rest of the word
 * there, which takes the position with it when it wraps to the next line.
 */
export function textThrough(value: string, position: number): string {
  return value.slice(0, position) + /^\S*/u.exec(value.slice(position))![0];
}

/** Whether a field shows a line: at least half of it lies inside the visible area. */
export function shows(view: FieldView, line: TextLine): boolean {
  const visible =
    Math.min(line.bottom, view.scrollTop + view.height) -
    Math.max(line.top, view.scrollTop);
  return visible >= (line.bottom - line.top) / 2;
}

/** Measured lines are a pixel out at most, as browsers round content heights. */
const tolerance = 1;

/**
 * Where a field scrolls to show all of a line: nowhere when it already shows all of it, and
 * otherwise the least move that brings the line to the near edge with the padding there. A field
 * shorter than the line and its padding shows the line's top.
 */
export function scrollToShow(view: FieldView, line: TextLine): number {
  const end = view.scrollTop + view.height;
  if (line.top >= view.scrollTop - tolerance && line.bottom <= end + tolerance)
    return view.scrollTop;
  const top = Math.max(0, line.top - view.paddingTop);
  return line.bottom > end
    ? Math.min(top, line.bottom + view.paddingBottom - view.height)
    : top;
}
