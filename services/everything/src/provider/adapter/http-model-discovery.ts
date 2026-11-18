import Anthropic from "@anthropic-ai/sdk";
import {
  providerLimits,
  type ProviderId,
} from "@everything/provider-contracts";
import type { VerificationInput } from "../interface/connection-verifier.js";
import type {
  DiscoveredModel,
  ModelLimits,
  ProviderModelDiscovery,
} from "../interface/provider-models.js";
import {
  advertisedLimits,
  serverPropsLimits,
} from "./advertised-model-limits.js";
import {
  anthropicReasoning,
  chatGptReasoning,
} from "./advertised-reasoning.js";
import { chatGptSpeeds } from "./advertised-speeds.js";
import { providerFetch } from "./provider-fetch.js";
import {
  anthropicImageInput,
  chatGptImageInput,
  compatibleImageInput,
} from "./advertised-image-input.js";
import { compatibleTextOutput } from "./advertised-text-output.js";
import { modelTokenLimit } from "../model/model-token-limit.js";

/** Discover account-specific catalogs through each configured provider's own endpoint. */
export class HttpModelDiscovery implements ProviderModelDiscovery {
  // ===========================================
  // Construction
  // ===========================================

  /** Allow deterministic protocol tests without using live credentials. */
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  // ===========================================
  // Discovery
  // ===========================================

  /** Keep provider order, dropping invalid IDs and models the provider says write no text. */
  async discover(
    provider: ProviderId,
    connection: VerificationInput,
  ): Promise<DiscoveredModel[]> {
    const models =
      provider === "anthropic"
        ? await this.anthropic(connection)
        : await this.openai(provider, connection);
    return [
      ...new Map(
        models
          .filter(
            (model) =>
              typeof model.id === "string" &&
              model.id.trim().length > 0 &&
              model.id.length <= providerLimits.modelLength,
          )
          .map((model) => [model.id, model]),
      ).values(),
    ];
  }

  /** Follow the official SDK's pagination for the API key's available Claude models and their efforts. */
  private async anthropic({
    credential,
  }: VerificationInput): Promise<DiscoveredModel[]> {
    const client = new Anthropic({
      apiKey: credential.apiKey!,
      maxRetries: 0,
      timeout: 30_000,
      fetch: providerFetch(this.fetcher),
    });
    const models: DiscoveredModel[] = [];
    for await (const model of client.models.list({ limit: 100 })) {
      const reasoning = anthropicReasoning(model.capabilities);
      const imageInput = anthropicImageInput(model.capabilities);
      // The Models API reports the input a model accepts and the most `max_tokens` it allows:
      // https://platform.claude.com/docs/en/api/models/list
      const contextWindow = modelTokenLimit(model.max_input_tokens);
      const maxOutputTokens = modelTokenLimit(model.max_tokens);
      models.push({
        id: model.id,
        name: model.display_name,
        ...(imageInput !== undefined ? { imageInput } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(reasoning ? { reasoning } : {}),
      });
    }
    return models;
  }

  /**
   * ChatGPT uses its account catalog, with any effort levels it lists; compatible servers may expose
   * only their verified model.
   */
  private async openai(
    provider: Exclude<ProviderId, "anthropic">,
    { credential, baseUrl, model }: VerificationInput,
  ): Promise<DiscoveredModel[]> {
    const token =
      provider === "chatgpt" ? credential.accessToken : credential.apiKey;
    const address =
      provider === "chatgpt" ? "https://api.openai.com/v1" : baseUrl!;
    const response = await providerFetch(this.fetcher)(`${address}/models`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(30_000),
    });
    if (
      provider === "openai-compatible" &&
      [404, 405, 501].includes(response.status) &&
      model
    )
      return [{ id: model, name: model }];
    if (!response.ok) throw new Error("Model discovery failed");
    if (provider === "chatgpt") {
      const result = (await response.json()) as {
        models: { slug: string; display_name?: string; visibility: string }[];
      };
      return result.models
        .filter((item) => item.visibility === "list")
        .map((item) => {
          const reasoning = chatGptReasoning(item);
          const speeds = chatGptSpeeds(item);
          const imageInput = chatGptImageInput(item);
          return {
            id: item.slug,
            name: item.display_name || item.slug,
            // SIWC documents identity fields, not guaranteed limits. Preserve optional limits
            // only when the response supplies fields understood and validated by our parser.
            ...advertisedLimits(item),
            ...(imageInput !== undefined ? { imageInput } : {}),
            ...(reasoning ? { reasoning } : {}),
            ...(speeds ? { speeds } : {}),
          };
        });
    }
    const result = (await response.json()) as { data: { id: string }[] };
    // A model the server doesn't describe stays listed: its name says nothing about what it does.
    const models: DiscoveredModel[] = result.data
      .filter(
        (item) =>
          typeof item.id === "string" && compatibleTextOutput(item) !== false,
      )
      .map((item) => {
        const imageInput = compatibleImageInput(item);
        return {
          id: item.id,
          name: item.id,
          ...advertisedLimits(item),
          ...(imageInput !== undefined ? { imageInput } : {}),
        };
      });
    // A single-model llama.cpp server lists only the context the model was trained with.
    const [only] = models;
    if (
      provider === "openai-compatible" &&
      models.length === 1 &&
      only!.contextWindow === undefined
    )
      return [{ ...only!, ...(await this.serverProps(address, token)) }];
    return models;
  }

  /** Read a llama.cpp server's running limits; any failure leaves the limits unknown. */
  private async serverProps(
    address: string,
    token: string | undefined,
  ): Promise<ModelLimits> {
    try {
      const response = await providerFetch(this.fetcher)(
        `${address.replace(/\/v1\/?$/, "")}/props`,
        {
          headers: token ? { authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(10_000),
        },
      );
      return response.ok ? serverPropsLimits(await response.json()) : {};
    } catch {
      return {};
    }
  }
}
