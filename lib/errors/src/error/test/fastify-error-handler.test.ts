import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { ApplicationError } from "../model/application-error.js";
import { errorHandler } from "../handler/fastify-error-handler.js";

/** Serve one route per failure kind through the production error handler. */
function createServer() {
  const app = Fastify({ bodyLimit: 16, logger: false });
  app.setErrorHandler(errorHandler);
  app.get("/expected", async () => {
    throw new ApplicationError(409, "CONFLICT", "Safe to show.");
  });
  app.get("/unexpected", async () => {
    throw new Error("connection string with a password");
  });
  app.post("/body", async () => ({ ok: true }));
  return app;
}

test("returns expected failures with their own status, code, and message", async (context) => {
  const app = createServer();
  context.after(() => app.close());
  const response = await app.inject({ url: "/expected" });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    code: "CONFLICT",
    message: "Safe to show.",
  });
});

test("maps correctable framework failures to stable codes", async (context) => {
  const app = createServer();
  context.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/body",
    payload: { text: "longer than sixteen bytes" },
  });
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().code, "REQUEST_TOO_LARGE");
});

test("rejects a content type no parser accepts without reporting an internal failure", async (context) => {
  const app = createServer();
  context.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/body",
    headers: { "content-type": "audio/webm" },
    payload: "abc",
  });
  assert.equal(response.statusCode, 415);
  assert.deepEqual(response.json(), {
    code: "UNSUPPORTED_MEDIA_TYPE",
    message: "The request's content type isn't supported.",
  });
});

test("hides unexpected failure details", async (context) => {
  const app = createServer();
  context.after(() => app.close());
  const response = await app.inject({ url: "/unexpected" });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    code: "INTERNAL_ERROR",
    message: "The request could not be completed.",
  });
});
