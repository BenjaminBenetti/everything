import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anthropicImageInput,
  chatGptImageInput,
  compatibleImageInput,
} from "../adapter/advertised-image-input.js";
import { HttpModelDiscovery } from "../adapter/http-model-discovery.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";

test("documented modality parsers distinguish true, false and malformed/absent", () => {
  for (const supported of [true, false]) {
    assert.equal(
      anthropicImageInput({ image_input: { supported } }),
      supported,
    );
    assert.equal(
      compatibleImageInput({
        architecture: {
          input_modalities: supported ? ["text", "image"] : ["text"],
        },
      }),
      supported,
    );
    assert.equal(
      chatGptImageInput({
        input_modalities: supported ? ["text", "image"] : ["text", "audio"],
      }),
      supported,
    );
  }
  for (const bad of [
    null,
    undefined,
    "yes",
    0,
    {},
    [],
    { supported: "true" },
  ]) {
    assert.equal(anthropicImageInput({ image_input: bad }), undefined);
  }
  for (const bad of [
    null,
    undefined,
    "text,image",
    [],
    ["text", null],
    ["image", 1],
    [""],
    ["text", "unrecognized-modality"],
    ["IMAGE"],
    Array(17).fill("text"),
  ]) {
    assert.equal(
      compatibleImageInput({ architecture: { input_modalities: bad } }),
      undefined,
    );
  }
  // Codex assumes text and image when the field is missing; a missing field here stays unknown.
  for (const bad of [
    null,
    undefined,
    "text,image",
    [],
    ["image"],
    ["text", null],
    ["text", "image", "video"],
    ["TEXT", "IMAGE"],
    [...Array(16).fill("text"), "image"],
  ]) {
    assert.equal(
      chatGptImageInput({ input_modalities: bad }),
      undefined,
      JSON.stringify(bad),
    );
  }
  // ChatGPT entries are read only in Codex's shape, not OpenRouter's.
  assert.equal(
    chatGptImageInput({
      architecture: { input_modalities: ["text", "image"] },
    }),
    undefined,
  );
  assert.equal(chatGptImageInput(null), undefined);
  assert.equal(compatibleImageInput(null), undefined);
  assert.equal(anthropicImageInput(null), undefined);
});

test("real discovery preserves documented advertised support, account identity and endpoint", async () => {
  for (const provider of ["anthropic", "openai-compatible"] as const) {
    const discovery = new HttpModelDiscovery(async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/v1/models");
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      if (provider === "anthropic") {
        assert.equal(url.origin, "https://api.anthropic.com");
        assert.equal(headers.get("x-api-key"), "synthetic-key");
        return Response.json({
          data: [true, false, undefined].map((supported, index) => ({
            id: `new-${index}`,
            display_name: `New ${index}`,
            capabilities: { image_input: { supported } },
            max_input_tokens: index === 0 ? 16384 : -1,
            max_tokens: 131072,
          })),
          has_more: false,
        });
      }
      assert.equal(url.origin, "http://offline.invalid");
      assert.equal(headers.get("authorization"), "Bearer synthetic-key");
      return Response.json({
        data: [true, false, undefined].map((supported, index) => ({
          id: `new-${index}`,
          context_length: 12345,
          architecture: {
            input_modalities:
              supported === undefined
                ? null
                : supported
                  ? ["text", "image"]
                  : ["text"],
          },
        })),
      });
    });
    const found = await discovery.discover(provider, {
      credential: { apiKey: "synthetic-key" },
      baseUrl: "http://offline.invalid/v1",
      model: null,
    });
    assert.deepEqual(
      found.map((model) => [model.id, model.imageInput]),
      [
        ["new-0", true],
        ["new-1", false],
        ["new-2", undefined],
      ],
    );
    if (provider === "anthropic") {
      assert.equal(found[0]?.contextWindow, 16384);
      assert.equal(found[1]?.contextWindow, undefined);
      // The Models API's max_tokens is the largest response the model allows.
      assert.equal(found[0]?.maxOutputTokens, 131072);
      assert.equal(
        new PiModelCapabilities().resolve("anthropic", "new-0", "", found[0])
          .maxTokens,
        16384,
        "a response cap never exceeds the reported context",
      );
    }
  }
});

test("SIWC image input comes only from a Codex-shaped list in the account's model list, never from a model's name", async () => {
  const capabilities = new PiModelCapabilities();
  const discovery = new HttpModelDiscovery(async (input, init) => {
    assert.equal(String(input), "https://api.openai.com/v1/models");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer dummy-oauth",
    );
    return Response.json({
      models: [
        // Identity only, plus OpenRouter's shape, which ChatGPT entries aren't read in.
        {
          slug: "gpt-6.1-terra",
          display_name: "Terra",
          visibility: "list",
          architecture: { input_modalities: ["text", "image"] },
        },
        {
          slug: "gpt-next-opaque",
          display_name: "Next",
          visibility: "list",
          input_modalities: ["text", "image"],
        },
        {
          slug: "gpt-6.1-terra-text",
          display_name: "Terra text",
          visibility: "list",
          input_modalities: ["text"],
        },
        { slug: "hidden", visibility: "hide" },
      ],
    });
  });
  const models = await discovery.discover("chatgpt", {
    credential: { accessToken: "dummy-oauth" },
    baseUrl: "http://ignored.invalid",
    model: null,
  });
  assert.deepEqual(models, [
    { id: "gpt-6.1-terra", name: "Terra" },
    { id: "gpt-next-opaque", name: "Next", imageInput: true },
    { id: "gpt-6.1-terra-text", name: "Terra text", imageInput: false },
  ]);
  const [terra, opaque, text] = models.map((model) =>
    capabilities.resolve(
      "chatgpt",
      model.id,
      "https://api.openai.com/v1",
      model,
    ),
  );
  // The once-documented ID gets nothing the list doesn't report.
  assert.deepEqual(terra!.input, ["text"]);
  assert.equal(terra!.maxTokens, 4096);
  assert.deepEqual(terra!.resolution, {
    provider: "chatgpt",
    model: "gpt-6.1-terra",
    contextWindow: 200000,
    contextSource: "fallback",
    imageInput: null,
    imageSource: "unknown",
  });
  assert.deepEqual(opaque!.input, ["text", "image"]);
  assert.deepEqual(
    [opaque!.resolution.imageInput, opaque!.resolution.imageSource],
    [true, "provider"],
  );
  assert.deepEqual(text!.input, ["text"]);
  assert.deepEqual(
    [text!.resolution.imageInput, text!.resolution.imageSource],
    [false, "provider"],
  );
  for (const id of [
    "gpt-6.1-terra",
    "gpt-6.1-terra-next",
    "custom-unlisted",
    "GPT-6.1-TERRA",
  ]) {
    const unknown = capabilities.resolve("chatgpt", id, "");
    assert.deepEqual(unknown.input, ["text"]);
    assert.equal(unknown.resolution.imageInput, null);
    assert.equal(unknown.resolution.imageSource, "unknown");
  }
  const gateway = capabilities.resolve(
    "openai-compatible",
    "gpt-6.1-terra",
    "http://offline.invalid/v1",
  );
  assert.equal(gateway.resolution.imageInput, null);
});

test("validated provider image flags decide for every model ID; invalid metadata cannot claim detection", async () => {
  const capabilities = new PiModelCapabilities();
  for (const id of ["gpt-6.1-terra", "gpt-4o"]) {
    // Normalized precedence contract, not proof that SIWC currently advertises a negative field.
    const model = capabilities.resolve(
      "chatgpt",
      id,
      "https://api.openai.com/v1",
      { imageInput: false, contextWindow: 8192 },
    );
    assert.deepEqual(model.input, ["text"]);
    assert.equal(model.id, id);
    assert.equal(model.api, "openai-responses");
    assert.equal(model.provider, "openai");
    assert.deepEqual(
      [
        model.resolution.imageInput,
        model.resolution.imageSource,
        model.contextWindow,
        model.resolution.contextSource,
      ],
      [false, "provider", 8192, "provider"],
    );
  }
  const outOfCatalog = capabilities.resolve(
    "openai-compatible",
    "advertised-only",
    "",
    { imageInput: true },
  );
  assert.deepEqual(outOfCatalog.input, ["text", "image"]);
  assert.equal(outOfCatalog.resolution.imageSource, "provider");
  // A model Pi's bundled catalog describes gets nothing from it.
  assert.deepEqual(capabilities.resolve("chatgpt", "gpt-4o", "").resolution, {
    provider: "chatgpt",
    model: "gpt-4o",
    contextWindow: 200000,
    contextSource: "fallback",
    imageInput: null,
    imageSource: "unknown",
  });
  for (const bad of ["true", null, 1, {}]) {
    const unknown = capabilities.resolve("chatgpt", "unlisted", "", {
      imageInput: bad as boolean,
      contextWindow: -1,
    });
    assert.equal(unknown.resolution.imageSource, "unknown");
    assert.equal(unknown.resolution.contextSource, "fallback");
  }
});
