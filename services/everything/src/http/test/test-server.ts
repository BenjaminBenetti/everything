import Fastify, { type FastifyInstance } from "fastify";
import { strictRequestValidation } from "../config/request-validation.js";
import { errorHandler } from "../handler/error-handler.js";

/** Subject every request to the test server is authenticated as. */
export const testSubject = "owner";

/** A Fastify instance with production validation and error mapping, authenticated as testSubject. */
export function authenticatedTestServer(): FastifyInstance {
  const app = Fastify({ ajv: strictRequestValidation });
  app.setErrorHandler(errorHandler);
  app.decorateRequest("identity", null);
  app.addHook("onRequest", async (request) => {
    request.identity = { subject: testSubject };
  });
  return app;
}
