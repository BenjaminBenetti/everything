import type { OpenAPIV3 } from "openapi-types";

/** The definition generated from the running service's authenticated routes. */
export type ApiDefinition = OpenAPIV3.Document;

/** Optional selection keeps on-demand documentation focused on the caller's task. */
export interface ApiDocumentationQuery {
  readonly path?: string;
  readonly method?: string;
}

/** The tool name requested for discovering the Everything API. */
export const apiDocumentationToolName = "everythion-api-docs";

/** HTTP operations that may be selected from the generated definition. */
export const apiDocumentationMethods = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
] as const;
