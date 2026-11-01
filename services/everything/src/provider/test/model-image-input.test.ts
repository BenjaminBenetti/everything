import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anthropicImageInput,
  compatibleImageInput,
} from "../adapter/advertised-image-input.js";
import { HttpModelDiscovery } from "../adapter/http-model-discovery.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";

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
      assert.equal(found[0]?.maxOutputTokens, undefined);
    }
  }
});

test("SIWC identity-only metadata uses the exact documentation fallback, never a fictional modality field", async () => {
  const capabilities = new PiModelCapabilities(await createModelRuntime());
  const discovery = new HttpModelDiscovery(async (input, init) => {
    assert.equal(String(input), "https://api.openai.com/v1/models");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer dummy-oauth",
    );
    return Response.json({
      models: [
        {
          slug: "gpt-6.1-terra",
          display_name: "Terra",
          visibility: "list",
          architecture: { input_modalities: ["text"] },
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
  assert.deepEqual(models, [{ id: "gpt-6.1-terra", name: "Terra" }]);
  const resolved = capabilities.resolve(
    "chatgpt",
    models[0]!.id,
    "https://api.openai.com/v1",
    models[0],
  );
  assert.deepEqual(resolved.input, ["text", "image"]);
  assert.equal(resolved.maxTokens, 4096);
  assert.deepEqual(resolved.resolution, {
    provider: "chatgpt",
    model: "gpt-6.1-terra",
    contextWindow: 200000,
    contextSource: "fallback",
    imageInput: true,
    imageSource: "documentation",
  });
  for (const id of [
    "gpt-6.1-terra-next",
    "gpt-6.1-terra-2026-10-26",
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

test("validated normalized provider negatives override docs/catalog; invalid metadata cannot claim detection", async () => {
  const capabilities = new PiModelCapabilities(await createModelRuntime());
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
  assert.equal(
    capabilities.resolve("chatgpt", "gpt-4", "").resolution.contextSource,
    "catalog",
  );
  assert.equal(
    capabilities.resolve("chatgpt", "gpt-4", "").resolution.imageInput,
    false,
  );
  for (const bad of ["true", null, 1, {}]) {
    const unknown = capabilities.resolve("chatgpt", "unlisted", "", {
      imageInput: bad as boolean,
      contextWindow: -1,
    });
    assert.equal(unknown.resolution.imageSource, "unknown");
    assert.equal(unknown.resolution.contextSource, "fallback");
  }
});
