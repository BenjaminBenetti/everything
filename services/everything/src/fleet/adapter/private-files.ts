import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

/** A file's content, or undefined when the file does not exist. */
export async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** A JSON file's object, or an empty one when the file does not exist. */
export async function readJsonObject(
  file: string,
): Promise<Record<string, unknown>> {
  const content = await readOptional(file);
  if (content === undefined) return {};
  const value: unknown = JSON.parse(content);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Replace a file with `content` all at once, so readers see the old file or the new one. A missing
 * folder is created with the directory mode, and the file gets exactly the file mode, whatever the
 * process's umask: both private by default.
 */
export async function replaceFile(
  file: string,
  content: string,
  modes: { readonly directory: number; readonly file: number } = {
    directory: 0o700,
    file: 0o600,
  },
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: modes.directory });
  const partial = `${file}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, content, { mode: modes.file });
    await chmod(partial, modes.file);
    await rename(partial, file);
  } finally {
    await rm(partial, { force: true });
  }
}

/** Replace a file readable only by Everything's user with JSON, all at once. */
export async function writePrivateJson(
  file: string,
  value: unknown,
): Promise<void> {
  await replaceFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
