import type { OpenAPIV3 } from "openapi-types";
import { ApiDocumentationUnavailableError } from "../error/api-documentation-errors.js";
import type {
  ApiDocumentationPublisher,
  ApiDocumentationReader,
} from "../interface/api-documentation.js";
import {
  apiDocumentationMethods,
  type ApiDefinition,
  type ApiDocumentationQuery,
} from "../model/api-documentation.js";

/** Own the generated snapshot independently of Fastify and provide isolated filtered copies. */
export class ApiDocumentationService
  implements ApiDocumentationReader, ApiDocumentationPublisher
{
  // ===========================================
  // State
  // ===========================================

  private definition: ApiDefinition | undefined;

  // ===========================================
  // Publication and inspection
  // ===========================================

  /** Copy schema data only; handlers, runtime instances, and credentials are never retained. */
  publish(definition: ApiDefinition): void {
    this.definition = structuredClone(definition);
  }

  /** Filter paths at segment boundaries, accepting Fastify and OpenAPI parameter spellings. */
  read(query: ApiDocumentationQuery = {}): ApiDefinition {
    if (!this.definition) throw new ApiDocumentationUnavailableError();
    const definition = structuredClone(this.definition);
    const prefix = query.path
      ?.replace(/:([A-Za-z0-9_]+)/g, "{$1}")
      .replace(/\/+$/, "");
    for (const [path, item] of Object.entries(definition.paths)) {
      if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) {
        delete definition.paths[path];
        continue;
      }
      if (!item || !query.method) continue;
      const method = query.method.toLowerCase();
      for (const candidate of apiDocumentationMethods) {
        const key = candidate.toLowerCase() as OpenAPIV3.HttpMethods;
        if (key !== method) delete item[key];
      }
      if (
        !apiDocumentationMethods.some(
          (candidate) => item[candidate.toLowerCase() as OpenAPIV3.HttpMethods],
        )
      )
        delete definition.paths[path];
    }
    return definition;
  }
}
