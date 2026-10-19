import { readFile } from "node:fs/promises";
import type { OutputSecrets } from "../interface/output-secrets.js";

/**
 * Secrets kept in files, read again for each command so a secret published or replaced after the
 * workspace started is redacted too. A file that is missing or unreadable holds no secret commands
 * could reveal through this account.
 */
export class FileOutputSecrets implements OutputSecrets {
  /** Read each secret from one of `files`, ignoring surrounding whitespace. */
  constructor(private readonly files: readonly string[]) {}

  async current(): Promise<readonly string[]> {
    const contents = await Promise.all(
      this.files.map((file) => readFile(file, "utf8").catch(() => "")),
    );
    return contents.map((content) => content.trim()).filter(Boolean);
  }
}
