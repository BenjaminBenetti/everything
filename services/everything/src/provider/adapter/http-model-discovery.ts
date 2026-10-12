import Anthropic from "@anthropic-ai/sdk";
import {
  providerLimits,
  type ProviderId,
} from "@everything/provider-contracts";
import type { VerificationInput } from "../interface/connection-verifier.js";
import type {
  DiscoveredModel,
  ProviderModelDiscovery,
} from "../interface/provider-models.js";
import { providerFetch } from "./provider-fetch.js";

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

  /** Preserve provider ordering and omit invalid or non-text model identities. */
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

  /** Follow the official SDK's pagination for the API key's available Claude models. */
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
    for await (const model of client.models.list({ limit: 100 }))
      models.push({ id: model.id, name: model.display_name });
    return models;
  }

  /** ChatGPT uses its account catalog; compatible servers may expose only their verified model. */
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
        .map((item) => ({
          id: item.slug,
          name: item.display_name || item.slug,
        }));
    }
    const result = (await response.json()) as { data: { id: string }[] };
    const models = result.data
      .filter(
        (item) =>
          typeof item.id === "string" &&
          !/embed|rerank|moderation|whisper|tts|image|dall-e|audio/i.test(
            item.id,
          ),
      )
      .map((item) => ({ id: item.id, name: item.id }));
    return models;
  }
}
