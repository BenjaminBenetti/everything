# Display workspace images in messages

A teammate can deliberately display a file using `send_message` with standard Markdown:

```md
![Chart](plots/chart-v1.png)
![Screenshot](</workspace/<this-teammate-id>/screenshots/Screen α.png>)
```

Relative paths start at the teammate's workspace root, regardless of the last shell working directory. Absolute paths must belong to that same teammate. Use angle brackets or Markdown URL escaping for spaces/Unicode. Only image nodes resolve workspace files: plain paths, code, ordinary links and file creation never post or expand an image. User display does not depend on the model's input-vision capability. Main-session delivery reaches the user's one conversation; fork replies remain private to their parent.

Supported bytes are PNG, JPEG, GIF and WebP, recognized by signature, valid geometry and bounded decode validation (25 MiB file, 40 million decoded pixels). SVG, HTML, malformed/oversized images, hidden files/folders, symlinks and hard-linked files are unavailable. There is no remote proxy, arbitrary-file download, resizing, encoding, rotation, copying, upload record or image-generation integration. Ordinary HTTP(S) Markdown images and existing `/v1/` content URLs retain their URL behavior.

The authenticated `/v1/agents/:agentId/workspace-image?path=...` route independently checks owner and teammate before reading. Fastify decodes the query once; the file reader never recursively decodes percent sequences. Markdown image URLs have their own single URL decode before query serialization; remaining percent sequences are literal filename characters. The root comes from workspace configuration. Each path component is opened without following links through held directory descriptors; root/file identity, regular-file status, size and modification facts are checked before returning validated original bytes. Concurrency and decode time are bounded. Responses are private/no-store, same-origin, no-sniff raster bytes. Errors expose no server path.

References show the **current file**, not a hidden snapshot. Moving/deleting/replacing a file affects old messages; use distinct versioned names for lasting history. History/reload works while the file exists. Missing or unsafe images show an unobtrusive alt-text fallback without polling/retry loops. No model/provider call is made by display or discovery.
