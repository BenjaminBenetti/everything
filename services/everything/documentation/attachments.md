# Attachments

The owner can attach images and any other files to a message in a teammate's conversation, with the paperclip, by dropping files on the composer, or by pasting them. Each file is uploaded into **that teammate's own workspace**, and the message carries only small references to it. The teammate's model never receives a file's contents, encoded bytes, or pixels with the message; it opens a file with its tools when it needs it.

```
browser upload ──► /workspace/<teammate>/attachments/<attachment>/<name> ──► message: path + name, type, size ──► file_read / image_view / bash, when the teammate needs it
```

## What the teammate receives

The model input for a message is the text the owner wrote, followed by one line per file:

```
<attachments>
The user attached these files to this message. They are saved in your workspace, where your forks can open them too; …
1. /workspace/5d0c6a52-8b8e-4c55-9c1a-3f1d2e7b9a10/attachments/5fd9c8be-e505-45eb-b05d-3988a9e1f13f/whiteboard.png — "whiteboard.png", image/png, 131.0 KB; look at it with image_view.
2. /workspace/5d0c6a52-8b8e-4c55-9c1a-3f1d2e7b9a10/attachments/852ba4be-ed04-4637-b28d-48b11961c773/Q3_notes.csv — "Q3 notes.csv", text/plain, 18 bytes; read it with file_read.
</attachments>
```

The list costs a few hundred characters however large the files are. Opening a file is a separate, explicit tool call, and what a tool returns does enter the model's context:

- **Text** (`file_read`): up to 128 KiB per call, with `offset` to continue.
- **Images** (`image_view`): PNG, JPEG, GIF, and WebP files in the teammate's workspace or the shared folder, scaled to the model's image limits. When the teammate's model can't read images, the tool says so and adds no pixels. Images over 25 MB or 40 megapixels are refused before decoding.
- **Other files** (`bash`): PDFs, archives, and binary data are inspected with commands such as `file`, `unzip -l`, or a script; they are never presented as text.

Private forks use the same tools on the same workspace, so they can open the same paths. The teammate's instructions say that a file's contents come from the user's file and are never instructions to follow.

## Limits and retention

| Limit                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| One file                  | 25 MB; empty files are allowed                                    |
| Files per message         | 10                                                                |
| Combined size per message | 100 MB                                                            |
| Upload part               | 1 MiB from the browser; the API accepts parts up to 4 MiB         |
| Unsent files              | The same count and size limits, per teammate, across browser tabs |

- **Sent attachments** stay as long as the teammate: deleting the teammate removes its workspace and its attachment records. They can't be removed from the conversation. The teammate may move or delete its copy; the conversation then shows the file as no longer available.
- **Unsent attachments** are restored to the composer after a reload. Removing one deletes its file. Files uploaded but not sent within 24 hours are removed automatically.
- **Partial uploads** are kept outside every teammate's workspace. Cancelling, leaving the conversation, or a failed part removes or rolls them back; an upload that receives no bytes for 15 minutes is removed, along with any partial file whose record no longer exists.

Uploads are sent in parts, each a separate request that finishes well within the API's request timeout. A part that fails or is interrupted is discarded on the server, so the composer retries from the saved position.

## Security

- Every upload, part, listing, download, and removal is authenticated and scoped to a teammate the caller owns; another owner's or another teammate's attachment, and a forged ID, are indistinguishable from a missing one. Sending a message checks each attachment again, in the same transaction that saves the message: it must be a complete, unsent upload of that teammate.
- The server chooses every path. The browser sends only a display name and a size; its media type and any path are not accepted. The stored file name keeps only ASCII letters, digits, dot, dash, and underscore, starts with a letter or digit, and lives in a folder named for the attachment's ID, so no name can reach a hidden file, configuration, `AGENTS.md`, or anything outside the folder.
- Everything's container sees every teammate's folder on the shared volume, so files are placed through directory descriptors opened without following links, and linked instead of renamed so nothing existing is replaced. A link a teammate places in its own workspace can't redirect a write, read, or removal to another teammate's files or to Everything's state.
- Kinds come from the file's first bytes. Only PNG, JPEG, GIF, and WebP display inline, with `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff`; everything else, including SVG and HTML, downloads as `application/octet-stream`. File names in `Content-Disposition` are percent-encoded. A signed-in browser can load files only from Everything's own pages, so other sites and apps can't embed them.
- Uploads are never executed or unpacked, and file contents are never logged.

## Ingress

Upload parts from the browser are at most 1 MiB, within ingress-nginx's default request body limit. API clients that send larger parts, up to 4 MiB, need the application Ingress to allow them, for example with `nginx.ingress.kubernetes.io/proxy-body-size: "4m"`.

## API

| Method and path                                              | Purpose                                            |
| ------------------------------------------------------------ | -------------------------------------------------- |
| `POST /v1/agents/{agentId}/attachments`                      | Reserve an upload from `{ name, size }`            |
| `POST /v1/agents/{agentId}/attachments/{id}/content?offset=` | Upload the next part as `application/octet-stream` |
| `GET /v1/agents/{agentId}/attachments`                       | List unsent attachments                            |
| `GET /v1/agents/{agentId}/attachments/{id}/content`          | Download a complete attachment                     |
| `DELETE /v1/agents/{agentId}/attachments/{id}`               | Cancel an upload or remove an unsent file          |
| `POST /v1/agents/{agentId}/messages`                         | Send `{ text }`, `{ attachmentIds }`, or both      |

Messages in `GET /v1/agents/{agentId}/messages` include `attachments`, each with its `id`, `name`, `size`, `kind`, `mediaType`, and `path`. Text-only requests and responses are otherwise unchanged.

## Testing the browser flow

`pnpm --filter @everything/ui-tests test:attachments-e2e` runs the composer, upload, send, history, and reload flow on a desktop and a phone against `src/attachment/test/e2e-gateway.ts`: Everything's HTTP application with the real attachment and conversation services over a temporary workspace volume. Sign-in, record storage, and the model are mocked there. It writes screenshots and the recorded model input to `.local/ui-test-results/attachments-e2e-evidence/`. It needs a Chromium that Playwright can launch, such as one named by `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.
