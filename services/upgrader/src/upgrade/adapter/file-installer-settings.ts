import { readFile } from "node:fs/promises";
import type { InstallerSettings } from "../interface/installer-settings.js";

/** The installer's settings file, mounted from the Secret the chart renders from them. */
export class FileInstallerSettings implements InstallerSettings {
  /** Bind the mounted file's path. */
  constructor(private readonly file: string) {}

  /** The chart renders an empty file until the installer passes its settings. */
  async saved(): Promise<boolean> {
    try {
      return (await readFile(this.file, "utf8")).trim().length > 0;
    } catch {
      return false;
    }
  }
}
