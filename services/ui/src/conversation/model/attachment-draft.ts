import {
  attachmentLimits,
  type AttachmentUpload,
} from "@everything/conversation-contracts/attachment";

/** Raster formats shown as a local preview before upload; anything else shows as a file. */
const previewTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Where one file in the composer is: uploading, ready to send, or stopped by a problem. */
export type DraftStatus = "uploading" | "ready" | "failed";

/** A file in the composer, before the message that carries it is sent. */
export interface DraftAttachment {
  /** Stable key for the composer; never sent to the server. */
  readonly key: string;
  readonly name: string;
  readonly size: number;
  readonly status: DraftStatus;
  /** Bytes the server has saved. */
  readonly received: number;
  /** The server's upload, once reserved. */
  readonly upload: AttachmentUpload | null;
  /** Why the upload stopped, written for the user. */
  readonly error: string | null;
  /** Whether this page still has the file, so a failed upload can be retried. */
  readonly retryable: boolean;
  /** A raster image preview address, or null to show a file chip. */
  readonly preview: string | null;
}

/** Changes to the composer's files. */
export type DraftAction =
  | { type: "added"; items: readonly DraftAttachment[] }
  | { type: "progressed"; key: string; upload: AttachmentUpload }
  | { type: "failed"; key: string; error: string }
  | { type: "retrying"; key: string }
  | { type: "removed"; key: string }
  | { type: "sent"; keys: readonly string[] }
  | {
      type: "restored";
      uploads: readonly AttachmentUpload[];
      preview: (upload: AttachmentUpload) => string | null;
    };

/** Apply one change; files keep the order they were attached in. */
export function draftReducer(
  state: readonly DraftAttachment[],
  action: DraftAction,
): readonly DraftAttachment[] {
  switch (action.type) {
    case "added":
      return [...state, ...action.items];
    case "progressed":
      return state.map((item) =>
        item.key === action.key
          ? {
              ...item,
              upload: action.upload,
              received: action.upload.received,
              status: action.upload.status === "ready" ? "ready" : "uploading",
              error: null,
            }
          : item,
      );
    case "failed":
      return state.map((item) =>
        item.key === action.key
          ? { ...item, status: "failed", error: action.error }
          : item,
      );
    case "retrying":
      return state.map((item) =>
        item.key === action.key
          ? { ...item, status: "uploading", error: null }
          : item,
      );
    case "removed":
      return state.filter((item) => item.key !== action.key);
    case "sent":
      return state.filter((item) => !action.keys.includes(item.key));
    case "restored": {
      const known = new Set(state.map((item) => item.upload?.id));
      return [
        ...action.uploads
          .filter((upload) => !known.has(upload.id))
          .map((upload): DraftAttachment => ({
            key: upload.id,
            name: upload.name,
            size: upload.size,
            received: upload.received,
            upload,
            // This page doesn't have the file of an upload begun elsewhere, so it can't continue it.
            status: upload.status === "ready" ? "ready" : "failed",
            error:
              upload.status === "ready"
                ? null
                : "This upload was interrupted. Remove it and attach the file again.",
            retryable: false,
            preview: upload.kind === "image" ? action.preview(upload) : null,
          })),
        ...state,
      ];
    }
  }
}

/** A new composer file for `file`, with a local preview only for raster images. */
export function draftFor(
  key: string,
  file: { readonly name: string; readonly size: number; readonly type: string },
  preview: () => string,
): DraftAttachment {
  return {
    key,
    name: file.name,
    size: file.size,
    status: "uploading",
    received: 0,
    upload: null,
    error: null,
    retryable: true,
    preview: previewTypes.has(file.type) ? preview() : null,
  };
}

/**
 * Split new files into those that fit the per-message limits, in order, and explanations for the
 * rest: files over the size limit, beyond the file count, or past the combined size.
 */
export function admitFiles<
  T extends { readonly name: string; readonly size: number },
>(
  current: readonly DraftAttachment[],
  files: readonly T[],
): { accepted: T[]; problems: string[] } {
  const accepted: T[] = [];
  const problems: string[] = [];
  let count = current.length;
  let total = current.reduce((sum, item) => sum + item.size, 0);
  for (const file of files) {
    if (file.size > attachmentLimits.maxFileBytes)
      problems.push(
        `${file.name} is larger than ${formatSize(attachmentLimits.maxFileBytes)}.`,
      );
    else if (count >= attachmentLimits.maxFiles)
      problems.push(
        `${file.name} wasn’t added: a message can have up to ${attachmentLimits.maxFiles} files.`,
      );
    else if (total + file.size > attachmentLimits.maxTotalBytes)
      problems.push(
        `${file.name} wasn’t added: files in one message can total up to ${formatSize(attachmentLimits.maxTotalBytes)}.`,
      );
    else {
      accepted.push(file);
      count++;
      total += file.size;
    }
  }
  return { accepted, problems };
}

/** What the composer can do with its files right now. */
export function draftSummary(items: readonly DraftAttachment[]) {
  const ready = items.filter((item) => item.status === "ready" && item.upload);
  return {
    /** Server IDs of files ready to send, in attachment order. */
    readyIds: ready.map((item) => item.upload!.id),
    readyKeys: ready.map((item) => item.key),
    uploading: items.filter((item) => item.status === "uploading").length,
    failed: items.filter((item) => item.status === "failed").length,
  };
}

/** A file size the way people read it. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
