import type { ApiDocumentationReader } from "../../api-documentation/interface/api-documentation.js";

/** Unrelated runtime tests offer the tool without requiring an HTTP application. */
export const testApiDocumentation: ApiDocumentationReader = {
  /** Supply a valid empty definition; documentation integration tests register real controllers. */
  read: () => ({
    openapi: "3.0.3",
    info: { title: "Test API", version: "1.0.0" },
    paths: {},
  }),
};
