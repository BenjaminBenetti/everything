import { useId, type ReactNode } from "react";

/** The ids a field's control needs to be named by its label and described by its help text. */
export interface JobFieldControl {
  readonly id: string;
  readonly describedBy: string | undefined;
}

/**
 * A labeled form control whose help text describes it without becoming part of its name: the label
 * holds only the field's name, and the help text is a separate element the control references.
 */
export function JobField({
  label,
  description,
  className = "",
  children,
}: {
  label: string;
  description?: ReactNode;
  className?: string;
  children: (control: JobFieldControl) => ReactNode;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  return (
    <div className={`field ${className}`.trim()}>
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy: description ? descriptionId : undefined })}
      {description && <small id={descriptionId}>{description}</small>}
    </div>
  );
}
