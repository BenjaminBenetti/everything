import { useEffect, useReducer, useRef, useState } from "react";
import {
  attachmentLimits,
  type AttachmentUpload,
} from "@everything/conversation-contracts/attachment";
import { HttpRequestError } from "../../http/model/http-request-error.js";
import { useAttachmentClient } from "../component/conversation-provider.js";
import {
  admitFiles,
  draftFor,
  draftReducer,
  draftSummary,
  type DraftAttachment,
} from "../model/attachment-draft.js";

/** Explain why an upload stopped, using the server's stable code and never its details. */
function uploadProblem(error: unknown): string {
  if (!(error instanceof HttpRequestError))
    return "The upload stopped. Check your connection and try again.";
  switch (error.code) {
    case "ATTACHMENT_LIMIT_REACHED":
      return `Files for one message can be up to ${attachmentLimits.maxFiles} files and ${attachmentLimits.maxTotalBytes / 1024 / 1024} MB in total. Remove some files first.`;
    case "ATTACHMENT_TOO_LARGE":
      return "This file is too large to upload.";
    case "ATTACHMENT_STORAGE_FAILED":
      return "The file couldn’t be saved in your teammate’s workspace. Try again.";
  }
  if (error.status === 404)
    return "This upload is no longer available. Remove it and attach the file again.";
  if (error.status === 401) return error.message;
  return "The upload stopped. Check your connection and try again.";
}

/**
 * The composer's files: uploaded one at a time in parts into the teammate's workspace, with progress,
 * retry from what the server saved, and removal. Files uploaded but not sent are restored after a
 * reload. Leaving the conversation stops uploads in progress and removes their partial files.
 */
export function useAttachmentDrafts(agentId: string) {
  const client = useAttachmentClient();
  const [items, dispatch] = useReducer(draftReducer, []);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const current = useRef<readonly DraftAttachment[]>(items);
  current.current = items;
  const files = useRef(new Map<string, File>());
  const transfers = useRef(new Map<string, AbortController>());
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const abort = new AbortController();
    client
      .unsent(agentId, abort.signal)
      .then((list) =>
        dispatch({
          type: "restored",
          uploads: list.attachments,
          preview: (upload) => client.contentUrl(agentId, upload.id),
        }),
      )
      .catch(() => undefined);
    return () => abort.abort();
  }, [agentId, client]);

  useEffect(
    () => () => {
      for (const transfer of transfers.current.values()) transfer.abort();
      for (const item of current.current) {
        release(item);
        // Only this page's own unfinished uploads; another tab may still be sending one it restored.
        if (item.retryable && item.upload && item.status !== "ready")
          void client.remove(agentId, item.upload.id).catch(() => undefined);
      }
    },
    [agentId, client],
  );

  /** Upload the file for `key` from the server's saved position until it is complete. */
  async function transfer(key: string): Promise<void> {
    const file = files.current.get(key);
    if (!file) return;
    const abort = new AbortController();
    transfers.current.set(key, abort);
    try {
      let upload: AttachmentUpload | null =
        current.current.find((item) => item.key === key)?.upload ?? null;
      if (upload?.status === "uploading") {
        // Continue from what the server saved, which can be more than this page saw before a failure.
        const id = upload.id;
        const saved = await client.unsent(agentId, abort.signal);
        upload = saved.attachments.find((item) => item.id === id) ?? null;
      }
      if (!upload) {
        upload = await client.create(agentId, {
          name: file.name,
          size: file.size,
        });
        if (!files.current.has(key)) {
          // Removed while the upload was being reserved.
          await client.remove(agentId, upload.id).catch(() => undefined);
          return;
        }
        dispatch({ type: "progressed", key, upload });
      }
      while (upload.status === "uploading") {
        abort.signal.throwIfAborted();
        upload = await client.upload(
          agentId,
          upload.id,
          upload.received,
          file.slice(
            upload.received,
            upload.received + attachmentLimits.chunkBytes,
          ),
          abort.signal,
        );
        dispatch({ type: "progressed", key, upload });
      }
    } catch (error) {
      if (!abort.signal.aborted)
        dispatch({ type: "failed", key, error: uploadProblem(error) });
    } finally {
      transfers.current.delete(key);
    }
  }

  /** Upload files one after another, so parts never compete for the connection. */
  function enqueue(key: string): void {
    queue.current = queue.current.then(() => transfer(key));
  }

  /** Release a local preview's memory. */
  function release(item: DraftAttachment): void {
    if (item.preview?.startsWith("blob:")) URL.revokeObjectURL(item.preview);
  }

  return {
    items,
    problems,
    ...draftSummary(items),

    /** Add files that fit the limits and start uploading them; explain the rest. */
    add(selected: readonly File[]): void {
      const { accepted, problems } = admitFiles(current.current, selected);
      setProblems(problems);
      const added = accepted.map((file) => {
        const key = crypto.randomUUID();
        files.current.set(key, file);
        return draftFor(key, file, () => URL.createObjectURL(file));
      });
      if (!added.length) return;
      current.current = [...current.current, ...added];
      dispatch({ type: "added", items: added });
      for (const item of added) enqueue(item.key);
    },

    /** Upload a failed file again from where the server stopped. */
    retry(key: string): void {
      dispatch({ type: "retrying", key });
      enqueue(key);
    },

    /** Stop and remove a file; files already sent are never touched here. */
    remove(key: string): void {
      const item = current.current.find((entry) => entry.key === key);
      transfers.current.get(key)?.abort();
      files.current.delete(key);
      dispatch({ type: "removed", key });
      if (!item) return;
      release(item);
      if (item.upload)
        void client.remove(agentId, item.upload.id).catch(() => undefined);
    },

    /** Forget files that were sent; they now belong to their message. */
    sent(keys: readonly string[]): void {
      for (const key of keys) {
        files.current.delete(key);
        const item = current.current.find((entry) => entry.key === key);
        if (item) release(item);
      }
      dispatch({ type: "sent", keys });
    },

    /** Hide the explanation of files that weren't added. */
    dismissProblems(): void {
      setProblems([]);
    },
  };
}
