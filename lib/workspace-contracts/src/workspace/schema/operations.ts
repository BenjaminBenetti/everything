import { Type, type Static } from "typebox";

/** Bounds shared by the tools, internal API, and execution adapters. */
export const workspaceLimits = {
  pathLength: 4096,
  writeBytes: 1024 * 1024,
  readBytes: 128 * 1024,
  outputBytes: 64 * 1024,
  commandLength: 64 * 1024,
  timeoutSeconds: 120,
  defaultTimeoutSeconds: 30,
} as const;

const filePath = Type.String({
  minLength: 1,
  maxLength: workspaceLimits.pathLength,
});

/** Read a bounded UTF-8 slice; offsets and lengths are bytes. */
export const fileReadInput = Type.Object(
  {
    path: filePath,
    offset: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: workspaceLimits.readBytes }),
    ),
  },
  { additionalProperties: false },
);

/** Replace a UTF-8 file, creating its parent directories. */
export const fileWriteInput = Type.Object(
  {
    path: filePath,
    content: Type.String({ maxLength: workspaceLimits.writeBytes }),
  },
  { additionalProperties: false },
);

/** Run one bounded, interruptible shell command. */
export const bashInput = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      maxLength: workspaceLimits.commandLength,
    }),
    cwd: Type.Optional(filePath),
    timeoutSeconds: Type.Optional(
      Type.Integer({ minimum: 1, maximum: workspaceLimits.timeoutSeconds }),
    ),
  },
  { additionalProperties: false },
);

export type FileReadInput = Static<typeof fileReadInput>;
export type FileWriteInput = Static<typeof fileWriteInput>;
export type BashInput = Static<typeof bashInput>;

/** File content with an explicit continuation offset for truncated reads. */
export interface FileReadResult {
  readonly content: string;
  readonly bytes: number;
  readonly nextOffset: number | null;
}

/** Confirmation of a completed file replacement. */
export interface FileWriteResult {
  readonly bytes: number;
}

/** Combined stdout/stderr, capped independently of the process exit status. */
export interface BashResult {
  readonly output: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}
