import type { FastifyReply, FastifyRequest } from "fastify";
import { lookup as mimeType } from "mime-types";
import type { ArtifactFile } from "@everything/artifact-contracts";
import type { Artifact } from "../../artifact/model/artifact.js";
import type { ContentStore } from "../../content/interface/content-store.js";
import type { ArtifactProxy } from "../adapter/artifact-proxy.js";
import { hostMessages, hostPage } from "../presenter/host-pages.js";
import type { StaticSite } from "../service/static-site.js";

/** What serving an artifact's content needs, shared by the artifact host and the public apps host. */
export interface ArtifactServingDependencies {
  readonly site: Pick<StaticSite, "resolve">;
  readonly content: Pick<ContentStore, "open">;
  readonly proxy: Pick<ArtifactProxy, "forward">;
}

/** Which page explains an app that has no live release or is stopped; it reads differently to owners and visitors. */
export interface UnavailableMessages {
  readonly unpublished: { readonly title: string; readonly message: string };
  readonly stopped: { readonly title: string; readonly message: string };
}

/** Send a short explanatory page, never cached. */
export function explain(
  reply: FastifyReply,
  status: number,
  page: { readonly title: string; readonly message: string },
): FastifyReply {
  return reply
    .code(status)
    .header("Cache-Control", "no-store")
    .type("text/html; charset=utf-8")
    .send(hostPage(page.title, page.message));
}

/** Send a stored file with validators, so unchanged files are not downloaded again. */
async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  content: Pick<ContentStore, "open">,
  file: ArtifactFile,
  status: number,
): Promise<FastifyReply> {
  const etag = `"${file.sha256}"`;
  reply
    .header("ETag", etag)
    .header("Cache-Control", "no-cache")
    .header("X-Content-Type-Options", "nosniff");
  if (status === 200 && request.headers["if-none-match"] === etag)
    return reply.code(304).send();
  reply
    .code(status)
    .type(mimeType(file.path) || "application/octet-stream")
    .header("Content-Length", file.size);
  return request.method === "HEAD"
    ? reply.send()
    : reply.send(await content.open(file.sha256));
}

/**
 * Serve one artifact's content: forward to a running dynamic app, or send a static file. The caller
 * has already decided the request may see this artifact; this function does not read credentials, so
 * it is identical for an owner on the artifact host and an anonymous visitor on the public apps host.
 */
export async function serveArtifact(
  request: FastifyRequest,
  reply: FastifyReply,
  artifact: Artifact,
  rawPath: string,
  query: string,
  dependencies: ArtifactServingDependencies,
  messages: UnavailableMessages,
): Promise<FastifyReply> {
  const { site, content, proxy } = dependencies;
  if (artifact.kind === "dynamic") {
    if (artifact.liveDeployment === null)
      return explain(reply, 503, messages.unpublished);
    if (!artifact.running) return explain(reply, 503, messages.stopped);
    return proxy.forward(request, reply, artifact, rawPath + query);
  }
  if (request.method !== "GET" && request.method !== "HEAD")
    return reply.code(405).header("Allow", "GET, HEAD").send();
  if (artifact.liveRevision !== null && !artifact.running)
    return explain(reply, 503, messages.stopped);
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return explain(reply, 404, hostMessages.notFound);
  }
  const resolution = await site.resolve(artifact, path);
  if (resolution.kind === "redirect")
    return reply.redirect(resolution.location + query, 308);
  if (resolution.kind === "missing")
    return explain(
      reply,
      404,
      artifact.liveRevision === null
        ? messages.unpublished
        : hostMessages.notFound,
    );
  return sendFile(request, reply, content, resolution.file, resolution.status);
}
