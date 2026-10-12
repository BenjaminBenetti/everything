import { ApplicationError } from "@everything/errors";

/** A deployment tried to set a variable the artifact service sets itself. */
export class ReservedVariableError extends ApplicationError {
  /** Name the reserved variable. */
  constructor(name: string) {
    super(
      400,
      "RESERVED_VARIABLE",
      `${name} is set by Everything and cannot be overridden.`,
    );
  }
}

/** The artifact's disk already exists with a different size. */
export class DiskSizeFixedError extends ApplicationError {
  /** Report the disk's size. */
  constructor(sizeGi: number) {
    super(
      409,
      "DISK_SIZE_FIXED",
      `This artifact's disk was created with ${sizeGi} GiB and cannot be resized. Deploy with diskGi ${sizeGi}, or null to run without it.`,
    );
  }
}
