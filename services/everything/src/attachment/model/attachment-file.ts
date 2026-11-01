import path from "node:path";
import { workspacePath } from "@everything/workspace-contracts/mount";
import { imageMediaType } from "../../workspace/model/image-format.js";
import {
  attachmentLimits,
  type AttachmentKind,
  type AttachmentLocation,
} from "./attachment.js";

/** Folder in each teammate's workspace that holds the files attached to its messages. */
export const attachmentFolder = "attachments";

/**
 * Controller-owned folder at the workspace volume's root for uploads still arriving. Teammate pods
 * mount only their own folder and the shared folder, so no teammate can reach a partial upload.
 */
export const attachmentStagingFolder = ".attachment-uploads";

/** Bytes read from the start of a complete file to tell what it is. */
export const attachmentSniffBytes = 8 * 1024;

/** Longest name a stored file is given, extension included. */
const storedNameLength = 120;

/** Removal of uploads that were abandoned or never sent, and how often to look for them. */
export const attachmentRetention = {
  /** An upload that receives no bytes for this long was abandoned. */
  staleUploadMs: 15 * 60 * 1000,
  /** An uploaded file that was never sent is removed after this long. */
  unsentMs: attachmentLimits.unsentRetentionMs,
  sweepIntervalMs: 10 * 60 * 1000,
} as const;

/** The pattern every stored file name matches: no separators, no leading dot, nothing to interpret. */
export const storedFileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** The final segment of a file name, without control, formatting, or direction-override characters. */
function cleanName(name: string): string {
  const segment = name.split(/[\\/]/).at(-1) ?? "";
  return segment
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
}

/**
 * The user's file name for display: its last path segment, without control, formatting, or
 * direction-override characters, within the length limit. Browsers report "C:\fakepath\…" for some
 * inputs; only the final name survives.
 */
export function displayName(name: string): string {
  const cleaned = [...cleanName(name)]
    .slice(0, attachmentLimits.nameLength)
    .join("")
    .trim();
  return cleaned || "file";
}

/**
 * A name safe to create inside the attachment's own folder: ASCII letters, digits, dot, dash, and
 * underscore, starting with a letter or digit, so it can't name a hidden file, a path, or an option.
 * The extension is kept when shortening so tools still recognize the format.
 */
export function storedFileName(name: string): string {
  const ascii = cleanName(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_");
  const dot = ascii.lastIndexOf(".");
  const extension =
    dot > 0 && /^[A-Za-z0-9]{1,16}$/.test(ascii.slice(dot + 1))
      ? ascii.slice(dot)
      : "";
  const stem = (extension ? ascii.slice(0, dot) : ascii)
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, storedNameLength - extension.length)
    .replace(/[._-]+$/, "");
  return stem ? `${stem}${extension}` : `file${extension}`;
}

/**
 * Where the teammate finds an attachment: `/workspace/<agent id>/attachments/<attachment id>/<name>`,
 * the same path in its pod, its private forks, and Everything's container.
 */
export function attachmentPath({
  agentId,
  id,
  fileName,
}: AttachmentLocation): string {
  if (
    !uuidPattern.test(agentId) ||
    !uuidPattern.test(id) ||
    !storedFileNamePattern.test(fileName)
  )
    throw new Error("Invalid attachment location");
  return path.posix.join(
    workspacePath(agentId),
    attachmentFolder,
    id,
    fileName,
  );
}

/** Recover the location of a saved attachment from its server-generated path. */
export function attachmentLocation(
  agentId: string,
  id: string,
  savedPath: string,
): AttachmentLocation {
  const location = { agentId, id, fileName: path.posix.basename(savedPath) };
  if (attachmentPath(location) !== savedPath)
    throw new Error("Invalid attachment location");
  return location;
}

/**
 * Tell what a file is from its first bytes, ignoring the name and type the browser reported: a
 * supported raster image, UTF-8 text without NUL bytes, or anything else. An empty file is text.
 */
export function classifyAttachment(head: Uint8Array): {
  kind: AttachmentKind;
  mediaType: string;
} {
  const image = imageMediaType(head);
  if (image) return { kind: "image", mediaType: image };
  if (ascii(head, 0, 5) === "%PDF-")
    return { kind: "binary", mediaType: "application/pdf" };
  if (!head.includes(0))
    try {
      // `stream` tolerates a character cut off at the end of the sample.
      new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
      return { kind: "text", mediaType: "text/plain" };
    } catch {
      // Not UTF-8: fall through to binary.
    }
  return { kind: "binary", mediaType: "application/octet-stream" };
}

/** The bytes from `start` to `end` read as ASCII. */
function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}
