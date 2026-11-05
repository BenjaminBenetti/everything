import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthenticatedTransport } from "../../http/adapter/authenticated-transport.js";
import { HttpRequestError } from "../../http/model/http-request-error.js";
import { HttpJobClient } from "../adapter/http-job-client.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

/** A transport over a fake fetch that records each request and answers with `respond`. */
function recording(respond: (path: string, options: RequestInit) => Response) {
  const requests: { path: string; options: RequestInit }[] = [];
  const transport = createAuthenticatedTransport(
    async (input, options = {}) => {
      requests.push({ path: String(input), options });
      return respond(String(input), options);
    },
  );
  return { requests, transport };
}

test("job operations use the teammate's job routes and send only the given fields", async () => {
  const { requests, transport } = recording((path, options) => {
    if (options.method === "DELETE" || path.endsWith("/stop"))
      return new Response(null, { status: 204 });
    if (path.endsWith("/preview"))
      return Response.json({ nextRuns: ["2026-11-06T08:00:00.000Z"] });
    if (path.endsWith("/runs") && !options.method)
      return Response.json({ runs: [] });
    if (!options.method && path.endsWith("/jobs"))
      return Response.json({ jobs: [] });
    return Response.json({ id: jobId });
  });
  const client = new HttpJobClient(transport);
  const schedule = { type: "interval", seconds: 900 } as const;
  assert.deepEqual(await client.list(agentId), []);
  await client.create(agentId, {
    name: "Check",
    instructions: "Check it.",
    schedule,
  });
  await client.update(agentId, jobId, { enabled: false });
  assert.deepEqual(await client.runs(agentId, jobId), []);
  await client.runNow(agentId, jobId);
  assert.equal(await client.stop(agentId, jobId), undefined);
  assert.deepEqual(await client.preview(agentId, schedule), [
    "2026-11-06T08:00:00.000Z",
  ]);
  assert.equal(await client.remove(agentId, jobId), undefined);
  const base = `/v1/agents/${agentId}/jobs`;
  assert.deepEqual(
    requests.map(({ path, options }) => [path, options.method ?? "GET"]),
    [
      [base, "GET"],
      [base, "POST"],
      [`${base}/${jobId}`, "PATCH"],
      [`${base}/${jobId}/runs`, "GET"],
      [`${base}/${jobId}/runs`, "POST"],
      [`${base}/${jobId}/stop`, "POST"],
      [`${base}/preview`, "POST"],
      [`${base}/${jobId}`, "DELETE"],
    ],
  );
  assert.equal(requests[2]!.options.body, JSON.stringify({ enabled: false }));
  assert.equal(requests[6]!.options.body, JSON.stringify({ schedule }));
});

test("job refusals are described in the client's own words; the server's text is never kept", async () => {
  const codes = ["JOB_RUN_ACTIVE", "JOB_SCHEDULE_INVALID", "UNKNOWN_CODE"];
  const { transport } = recording(() =>
    Response.json(
      { code: codes.shift(), message: "Server text <b>not shown</b>" },
      { status: 409 },
    ),
  );
  const client = new HttpJobClient(transport);
  await assert.rejects(
    client.runNow(agentId, jobId),
    (error: unknown) =>
      error instanceof HttpRequestError &&
      error.code === "JOB_RUN_ACTIVE" &&
      error.message ===
        "This job is already running. Wait for it to finish or stop it first.",
  );
  await assert.rejects(
    client.preview(agentId, { type: "interval", seconds: 900 }),
    /keep runs at least five minutes apart/,
  );
  await assert.rejects(
    client.runNow(agentId, jobId),
    (error: unknown) =>
      error instanceof HttpRequestError &&
      error.message === "We couldn’t complete that request. Please try again.",
  );
});
