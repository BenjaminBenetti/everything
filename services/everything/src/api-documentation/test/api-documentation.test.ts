import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { Type } from "typebox";
import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIV3 } from "openapi-types";
import {
  createHttpApplication,
  type HttpDependencies,
} from "../../application/factory/http-application.js";
import { mainAgentPrompt } from "../../runtime/prompt/main-agent-prompt.js";
import { registerApiDocumentation } from "../adapter/fastify-api-documentation.js";
import { ApiDocumentationService } from "../service/api-documentation-service.js";
import { apiDocumentationTool } from "../tool/api-documentation-tool.js";
import { apiDocumentationToolName } from "../model/api-documentation.js";
import { TelemetryQueryService } from "../../telemetry/service/telemetry-query-service.js";

/** Any business-operation invocation while producing docs fails immediately. */
function unusedOperations<T>(): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => () =>
        assert.fail(`Documentation invoked ${String(property)}`),
    },
  ) as T;
}

/** Compose the actual production controllers while keeping data stores and runtime services inaccessible. */
function dependencies(
  documentation: ApiDocumentationService,
): HttpDependencies {
  return {
    apiDocumentation: documentation,
    verifier: { verify: async () => ({ subject: "docs-owner" }) },
    sessions: {
      ...unusedOperations(),
      resolve: async () => undefined,
    } as HttpDependencies["sessions"],
    publicOrigin: "https://everything.test",
    chatGptRedirectUri: "http://127.0.0.1:8080/v1/providers/chatgpt/callback",
    keys: unusedOperations(),
    credentialGrants: unusedOperations(),
    credentialRollouts: unusedOperations(),
    providers: unusedOperations(),
    models: unusedOperations(),
    agents: unusedOperations(),
    agentActivity: unusedOperations(),
    profiles: unusedOperations(),
    removal: unusedOperations(),
    conversations: unusedOperations(),
    subagents: unusedOperations(),
    updates: unusedOperations(),
    upgrades: unusedOperations(),
    artifacts: unusedOperations(),
    workers: unusedOperations(),
    generalSettings: unusedOperations(),
    teammateOrder: unusedOperations(),
    workspaces: unusedOperations(),
    workspaceActivity: unusedOperations(),
    voice: unusedOperations(),
    voiceStreams: unusedOperations(),
    telemetry: new TelemetryQueryService(
      { enabled: false, retentionDays: 7 },
      null,
    ),
    readiness: async () => {},
  };
}

test("the production API reflects valid complete schemas, protects the document, and excludes non-API routes", async (context) => {
  const documentation = new ApiDocumentationService();
  assert.throws(() => documentation.read(), {
    code: "API_DOCUMENTATION_UNAVAILABLE",
  });
  const app = await createHttpApplication(dependencies(documentation));
  context.after(() => app.close());
  assert.equal((await app.inject("/v1/openapi.json")).statusCode, 401);
  const response = await app.inject({
    url: "/v1/openapi.json",
    headers: { authorization: "Bearer docs-test-token" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const definition = response.json<OpenAPIV3.Document>();
  assert.deepEqual(definition, documentation.read());
  await SwaggerParser.validate(structuredClone(definition));
  assert.ok(Object.keys(definition.paths).length > 20);
  for (const path of Object.keys(definition.paths))
    assert.ok(path.startsWith("/v1/"), path);
  assert.ok(
    !Object.keys(definition.paths).some((path) =>
      /session|callback|health|internal/.test(path),
    ),
  );
  assert.deepEqual(definition.security, [{ bearerAuth: [] }]);
  assert.deepEqual(
    definition.servers?.map((server) => server.url),
    ["/"],
  );
  const full = (await SwaggerParser.dereference(
    structuredClone(definition),
  )) as OpenAPIV3.Document;
  const wakeup = full.paths["/v1/agents/{agentId}/subagent/wakeup"]!.post!;
  assert.match(wakeup.description!, /temporary|Temporary/);
  assert.match(wakeup.description!, /deleted/);
  assert.match(wakeup.description!, /409/);
  assert.deepEqual(Object.keys(wakeup.responses).sort(), ["202", "default"]);
  const request = wakeup.requestBody as OpenAPIV3.RequestBodyObject;
  const schema = request.content["application/json"]!
    .schema as OpenAPIV3.SchemaObject;
  assert.deepEqual(schema.required, ["task"]);
  assert.equal(
    (schema.properties!.task as OpenAPIV3.SchemaObject).maxLength,
    32000,
  );
  assert.equal(
    (schema.properties!.context as OpenAPIV3.SchemaObject).type,
    "boolean",
  );
  const result = wakeup.responses[202] as OpenAPIV3.ResponseObject;
  assert.deepEqual(
    (result.content!["application/json"]!.schema as OpenAPIV3.SchemaObject)
      .required,
    ["id", "parentId", "status"],
  );
  const deletion =
    full.paths["/v1/agents/{agentId}/subagent/{subagentId}"]!.delete!;
  assert.equal(
    (deletion.responses[204] as OpenAPIV3.ResponseObject).content,
    undefined,
  );
  const apiKey = full.paths["/v1/artifacts/{appId}/api-key"]!.get!;
  assert.match(apiKey.description!, /X-Api-Key/);
  assert.deepEqual(
    (
      (apiKey.responses[200] as OpenAPIV3.ResponseObject).content![
        "application/json"
      ]!.schema as OpenAPIV3.SchemaObject
    ).required,
    ["apiKey"],
  );
  const listed = (
    full.paths["/v1/artifacts"]!.get!.responses[200] as OpenAPIV3.ResponseObject
  ).content!["application/json"]!.schema as OpenAPIV3.SchemaObject;
  assert.match(JSON.stringify(listed), /"api-key"/);
  assert.doesNotMatch(JSON.stringify(listed), /apiKey/);
  for (const path of Object.values(full.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const operation = path?.[method];
      if (!operation) continue;
      assert.ok(operation.summary);
      assert.ok(
        Object.keys(operation.responses).some((code) => /^2\d\d$/.test(code)),
        operation.summary,
      );
    }
  }
});

test("new routes and changed constraints appear automatically without editing a documentation catalog", async (context) => {
  for (const maximum of [7, 19]) {
    const app = Fastify();
    context.after(() => app.close());
    const documentation = new ApiDocumentationService();
    app.get("/health", async () => ({ ready: true }));
    await app.register(
      async (scope) => {
        await registerApiDocumentation(scope, documentation);
        scope.post(
          "/future/:id",
          {
            schema: {
              summary: "A future API operation",
              params: Type.Object({ id: Type.String() }),
              body: Type.Object({ text: Type.String({ maxLength: maximum }) }),
              response: { 201: Type.Object({ accepted: Type.Boolean() }) },
            },
          },
          async () => assert.fail("Reflection must never call a handler"),
        );
      },
      { prefix: "/v1" },
    );
    await app.ready();
    const definition = documentation.read();
    await SwaggerParser.validate(structuredClone(definition));
    assert.deepEqual(Object.keys(definition.paths), ["/v1/future/{id}"]);
    const body = definition.paths["/v1/future/{id}"]!.post!
      .requestBody as OpenAPIV3.RequestBodyObject;
    const schema = body.content["application/json"]!
      .schema as OpenAPIV3.SchemaObject;
    assert.equal(
      (schema.properties!.text as OpenAPIV3.SchemaObject).maxLength,
      maximum,
    );
  }
});

test("the docs tool returns filtered isolated definitions and the caller's teammate ID without credentials", async (context) => {
  const documentation = new ApiDocumentationService();
  const app = await createHttpApplication(dependencies(documentation));
  context.after(() => app.close());
  await app.ready();
  const tool = apiDocumentationTool(documentation, "current-teammate");
  assert.equal(tool.name, apiDocumentationToolName);
  const result = await tool.execute(
    "call",
    { path: "/v1/agents/:agentId/subagent/", method: "POST" },
    undefined,
    undefined,
    undefined as never,
  );
  const output = JSON.parse((result.content[0] as { text: string }).text) as {
    agentId: string;
    definition: OpenAPIV3.Document;
  };
  assert.equal(output.agentId, "current-teammate");
  assert.deepEqual(
    Object.keys(output.definition.paths).sort(),
    [
      "/v1/agents/{agentId}/subagent",
      "/v1/agents/{agentId}/subagent/wakeup",
      "/v1/agents/{agentId}/subagent/{subagentId}/messages",
    ].sort(),
  );
  for (const item of Object.values(output.definition.paths))
    assert.deepEqual(Object.keys(item!), ["post"]);
  await SwaggerParser.validate(structuredClone(output.definition));
  output.definition.paths = {};
  assert.ok(Object.keys(documentation.read().paths).length > 20);
  assert.deepEqual(documentation.read({ path: "/v1/agent" }).paths, {});
  assert.deepEqual(
    documentation.read({
      path: "/v1/agents/{agentId}/subagent/wakeup",
      method: "DELETE",
    }).paths,
    {},
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tool.execute(
      "cancelled",
      {},
      controller.signal,
      undefined,
      undefined as never,
    ),
    { name: "AbortError" },
  );
  const prompt = mainAgentPrompt({
    id: "current-teammate",
    name: "Ada",
    systemPrompt: "Help",
  });
  assert.ok(prompt.includes(apiDocumentationToolName));
  assert.ok(prompt.includes("subagent/wakeup"));
  assert.ok(
    mainAgentPrompt(
      { id: "current-teammate", name: "Ada", systemPrompt: "Help" },
      { id: "fork", parentId: "main" },
    ).includes(apiDocumentationToolName),
  );
});
