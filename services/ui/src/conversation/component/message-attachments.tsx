import { useState } from "react";
import { Download, FileText, ImageOff } from "lucide-react";
import type { MessageAttachment } from "@everything/conversation-contracts/attachment";
import { useAttachmentClient } from "./conversation-provider.js";
import { formatSize } from "../model/attachment-draft.js";

/** A short description of what the server found the file to be. */
const kindText: Record<MessageAttachment["kind"], string> = {
  image: "Image",
  text: "Text",
  binary: "File",
};

/** An image preview that becomes a plain file row if the teammate has since moved or deleted it. */
function ImageAttachment({
  attachment,
  url,
}: {
  attachment: MessageAttachment;
  url: string;
}) {
  const [missing, setMissing] = useState(false);
  if (missing)
    return (
      <div className="chat-sent-file" title={attachment.path}>
        <ImageOff aria-hidden="true" />
        <span className="chat-sent-file-details">
          <span className="chat-attachment-name">{attachment.name}</span>
          <span className="chat-attachment-status">
            No longer in your teammate’s workspace
          </span>
        </span>
      </div>
    );
  return (
    <figure className="chat-sent-image">
      <a href={url} target="_blank" rel="noopener noreferrer">
        <img
          src={url}
          alt={attachment.name}
          loading="lazy"
          onError={() => setMissing(true)}
        />
      </a>
      <figcaption>
        <span className="chat-attachment-name">{attachment.name}</span>
        <code title={attachment.path}>{attachment.path}</code>
      </figcaption>
    </figure>
  );
}

/**
 * Files sent with a message: images display from the teammate's workspace and other files download.
 * Each shows the path where the teammate finds it.
 */
export function MessageAttachments({
  agentId,
  attachments,
}: {
  agentId: string;
  attachments: readonly MessageAttachment[];
}) {
  const client = useAttachmentClient();
  if (!attachments.length) return null;
  return (
    <ul className="chat-sent-attachments" aria-label="Attached files">
      {attachments.map((attachment) => {
        const url = client.contentUrl(agentId, attachment.id);
        return (
          <li key={attachment.id}>
            {attachment.kind === "image" ? (
              <ImageAttachment attachment={attachment} url={url} />
            ) : (
              <a
                className="chat-sent-file"
                href={url}
                download={attachment.name}
                aria-label={`Download ${attachment.name}, ${kindText[attachment.kind].toLowerCase()}, ${formatSize(attachment.size)}`}
              >
                <FileText aria-hidden="true" />
                <span className="chat-sent-file-details">
                  <span className="chat-attachment-name">
                    {attachment.name}
                  </span>
                  <span className="chat-attachment-status">
                    {kindText[attachment.kind]} · {formatSize(attachment.size)}
                  </span>
                  <code title={attachment.path}>{attachment.path}</code>
                </span>
                <Download
                  aria-hidden="true"
                  className="chat-sent-file-action"
                />
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
