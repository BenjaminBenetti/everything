import type { Readable } from "node:stream";
import { pack, type Pack } from "tar-stream";
import type { ArtifactFile } from "@everything/artifact-contracts";
import type { ContentStore } from "../interface/content-store.js";

/** Stream a tar archive of the files, preserving executable bits, for a build to unpack. */
export function archiveSource(
  files: readonly ArtifactFile[],
  content: Pick<ContentStore, "open">,
): Pack {
  const archive = pack();
  /** Add each file in turn, then finish the archive or fail it. */
  async function fill(): Promise<void> {
    for (const file of files) {
      const source = await content.open(file.sha256);
      await addEntry(archive, file, source);
    }
    archive.finalize();
  }
  fill().catch((error: unknown) => archive.destroy(error as Error));
  return archive;
}

/** Copy one file's content into its archive entry, resolving once the entry is complete. */
function addEntry(
  archive: Pack,
  file: ArtifactFile,
  source: Readable,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const entry = archive.entry(
      {
        name: file.path,
        size: file.size,
        mode: file.executable ? 0o755 : 0o644,
        mtime: new Date(0),
      },
      (error) => (error ? reject(error) : resolve()),
    );
    source.once("error", reject);
    source.pipe(entry);
  });
}
