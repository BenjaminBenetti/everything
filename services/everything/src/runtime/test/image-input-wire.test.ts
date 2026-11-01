import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import {
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ProviderId } from "@everything/provider-contracts";
import { HttpModelDiscovery } from "../../provider/adapter/http-model-discovery.js";
import { ProviderModelService } from "../../provider/service/provider-models.js";
import { PiModelCapabilities } from "../adapter/pi-model-capabilities.js";
import { PiInferenceRuntimeFactory } from "../adapter/pi-inference-runtime.js";
import { createModelRuntime } from "../factory/model-runtime.js";
import { imageTools } from "../tool/image-tools.js";
import {
  pngBytes,
  workspaceVolume,
} from "../../attachment/test/attachment-fixtures.js";

/** Minimal successful native protocol responses; never provider inference. */
function reply(provider: ProviderId, model: string): Response {
  const headers = { "content-type": "text/event-stream" };
  if (provider === "openai-compatible")
    return new Response(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers },
    );
  const events =
    provider === "anthropic"
      ? [
          {
            type: "message_start",
            message: {
              id: "mock",
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 0 },
          },
          { type: "message_stop" },
        ]
      : [
          { type: "response.created", response: { id: "mock" } },
          {
            type: "response.completed",
            response: { id: "mock", status: "completed", output: [] },
          },
        ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers },
  );
}

for (const provider of ["anthropic", "chatgpt", "openai-compatible"] as const) {
  test(`${provider}: real discovery/resolver/image_view/native SDK preserve exact PNG bytes and block negative/unknown/disabled images`, async (context) => {
    let networkAttempts = 0;
    context.mock.method(globalThis, "fetch", async () => {
      networkAttempts++;
      throw new Error("External network forbidden");
    });
    const volume = await workspaceVolume(context);
    const id =
      provider === "chatgpt" ? "gpt-6.1-terra" : "outside-catalog-wire-fixture";
    const capabilities = new PiModelCapabilities(await createModelRuntime());
    let advertised: boolean | undefined = true;
    const connections = {
      async access(owner: string, actual: ProviderId) {
        assert.equal(owner, "synthetic-owner");
        assert.equal(actual, provider);
        return {
          credential: { apiKey: "dummy-key", accessToken: "dummy-oauth" },
          baseUrl: "http://offline.invalid/v1",
          model: null,
        };
      },
    };
    const choices = new ProviderModelService(
      connections,
      new HttpModelDiscovery(async (url, init) => {
        assert.equal(new URL(String(url)).pathname, "/v1/models");
        assert.equal(init?.redirect, "error");
        if (provider === "chatgpt") {
          assert.equal(String(url), "https://api.openai.com/v1/models");
          return Response.json({ models: [{ slug: id, visibility: "list" }] });
        }
        if (provider === "anthropic")
          return Response.json({
            data: [
              {
                id,
                display_name: id,
                capabilities: { image_input: { supported: advertised } },
              },
            ],
            has_more: false,
          });
        return Response.json({
          data: [
            {
              id,
              context_length: 32768,
              architecture: {
                input_modalities:
                  advertised === undefined
                    ? null
                    : advertised
                      ? ["text", "image"]
                      : ["text"],
              },
            },
          ],
        });
      }),
      capabilities,
    );
    const bodies: ReturnType<typeof JSON.parse>[] = [];
    const factory = new PiInferenceRuntimeFactory(
      connections,
      choices,
      capabilities,
      async (url, init) => {
        const expected =
          provider === "anthropic"
            ? "https://api.anthropic.com/v1/messages"
            : provider === "chatgpt"
              ? "https://api.openai.com/v1/responses"
              : "http://offline.invalid/v1/chat/completions";
        const address = new URL(String(url));
        assert.equal(address.origin, new URL(expected).origin);
        assert.equal(address.pathname, new URL(expected).pathname);
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (provider === "chatgpt") {
          assert.ok([id, "unknown-wire-fixture"].includes(body.model));
          assert.equal(
            body.max_output_tokens,
            undefined,
            "SIWC request contract is preserved",
          );
        }
        return reply(provider, id);
      },
    );
    const selection = { provider, model: id, effort: "off" } as const;
    const runtime = await factory.create("synthetic-owner", selection);
    assert.equal(
      runtime.info?.imageSource,
      provider === "chatgpt" ? "documentation" : "provider",
    );
    assert.ok(runtime.model.input.includes("image"));
    if (provider === "chatgpt")
      assert.deepEqual(
        [runtime.model.contextWindow, runtime.info?.contextSource],
        [200000, "fallback"],
      );
    let reads = 0;
    const [tool] = imageTools(
      {
        async read(agent, file) {
          assert.equal(agent, "synthetic-teammate");
          assert.equal(file, "fixture.png");
          reads++;
          return {
            bytes: pngBytes,
            mediaType: "image/png",
            width: 2,
            height: 1,
          };
        },
      },
      "synthetic-teammate",
    );
    const result = await tool!.execute(
      "view",
      { path: "fixture.png" },
      undefined,
      undefined,
      { model: runtime.model } as never,
    );
    const pixels = result.content.find((block) => block.type === "image");
    assert.ok(pixels && pixels.type === "image");
    assert.deepEqual(Buffer.from(pixels.data, "base64"), pngBytes);
    const history: Parameters<typeof convertToLlm>[0] = [
      { role: "user", content: "View fixture.png", timestamp: 1 },
      {
        role: "assistant",
        api: runtime.model.api,
        provider: runtime.model.provider,
        model: id,
        content: [
          {
            type: "toolCall",
            id: "view",
            name: "image_view",
            arguments: { path: "fixture.png" },
          },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "view",
        toolName: "image_view",
        content: result.content,
        isError: false,
        timestamp: 3,
      },
    ];
    const llm = { messages: convertToLlm(history) };
    const answer = await runtime.models.completeSimple(runtime.model, llm);
    assert.equal(answer.stopReason, "stop", JSON.stringify(answer));
    const body = bodies.at(-1)!;
    let encoded: string;
    if (provider === "anthropic") {
      const output = body.messages
        .flatMap((message: { content: unknown[] }) => message.content)
        .find(
          (block: { type: string }) => block.type === "tool_result",
        ).content;
      const image = output.find(
        (block: { type: string }) => block.type === "image",
      );
      assert.equal(image.source.type, "base64");
      assert.equal(image.source.media_type, "image/png");
      encoded = image.source.data;
    } else if (provider === "chatgpt") {
      const output = body.input.find(
        (block: { type: string }) => block.type === "function_call_output",
      ).output;
      assert.ok(Array.isArray(output));
      const image = output.find(
        (block: { type: string }) => block.type === "input_image",
      );
      assert.equal(image.detail, "auto");
      assert.ok(image.image_url.startsWith("data:image/png;base64,"));
      encoded = image.image_url.split(",")[1];
    } else {
      const index = body.messages.findIndex(
        (message: { role: string }) => message.role === "tool",
      );
      assert.equal(typeof body.messages[index].content, "string");
      assert.ok(!body.messages[index].content.includes(pixels.data));
      assert.equal(body.messages[index + 1].role, "user");
      const image = body.messages[index + 1].content.find(
        (block: { type: string }) => block.type === "image_url",
      );
      assert.ok(image.image_url.url.startsWith("data:image/png;base64,"));
      encoded = image.image_url.url.split(",")[1];
    }
    assert.deepEqual(Buffer.from(encoded!, "base64"), pngBytes);

    for (const negative of [false, undefined]) {
      advertised = negative;
      // SIWC has no supported wire modality contract. Exercise normalized precedence without inventing one.
      const denied =
        provider === "chatgpt"
          ? capabilities.resolve(
              provider,
              negative === false ? id : "unknown-wire-fixture",
              runtime.model.baseUrl,
              negative === false ? { imageInput: false } : {},
            )
          : (await factory.create("synthetic-owner", selection)).model;
      assert.deepEqual(denied.input, ["text"]);
      const refusal = await tool!.execute(
        "view",
        { path: "fixture.png" },
        undefined,
        undefined,
        { model: denied } as never,
      );
      assert.equal(refusal.content.length, 1);
      assert.match(
        (refusal.content[0] as { text: string }).text,
        /unavailable or unconfirmed/,
      );
      assert.equal(reads, 1, "refusal happens before pixel reads");
      const negativeAnswer = await runtime.models.completeSimple(denied, llm);
      assert.equal(
        negativeAnswer.stopReason,
        "stop",
        JSON.stringify(negativeAnswer),
      );
      assert.ok(!JSON.stringify(bodies.at(-1)).includes(pixels.data));
      assert.match(JSON.stringify(bodies.at(-1)), /tool image omitted/);
    }

    // Exercise Pi's actual dynamic images.blockImages converter, not a hand-written imitation.
    const settings = SettingsManager.inMemory({
      images: { blockImages: true },
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const cwd = volume.workspace("image-block-fixture");
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: path.join(cwd, ".pi"),
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "Synthetic wire test.",
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: path.join(cwd, ".pi"),
      model: runtime.model,
      modelRuntime: runtime.models,
      settingsManager: settings,
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader: loader,
      tools: [],
    });
    context.after(() => session.dispose());
    const before = bodies.length;
    const disabledMessages = await session.agent.convertToLlm(history);
    assert.equal(
      (
        await runtime.models.completeSimple(runtime.model, {
          messages: disabledMessages,
        })
      ).stopReason,
      "stop",
    );
    assert.equal(bodies.length, before + 1);
    assert.ok(!JSON.stringify(bodies.at(-1)).includes(pixels.data));
    assert.match(JSON.stringify(bodies.at(-1)), /Image reading is disabled/);
    assert.equal(reads, 1);
    assert.equal(networkAttempts, 0);
  });
}
