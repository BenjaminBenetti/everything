import { readFile } from "node:fs/promises";
import type { AccessTokenSource } from "@everything/security/client-credentials";

/** A service account token the kubelet keeps current in a projected volume; each read gets the latest. */
export class ProjectedTokenSource implements AccessTokenSource {
  /** Bind the token file's path. */
  constructor(private readonly file: string) {}

  /** Read the token the kubelet last wrote. */
  async token(): Promise<string> {
    const token = (await readFile(this.file, "utf8")).trim();
    if (!token) throw new Error("The service account token file is empty");
    return token;
  }
}
