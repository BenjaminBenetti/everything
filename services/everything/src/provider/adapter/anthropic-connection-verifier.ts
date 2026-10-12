import Anthropic from "@anthropic-ai/sdk";
import type {
  ConnectionVerifier,
  VerificationInput,
} from "../interface/connection-verifier.js";
import {
  ProviderVerificationError,
  verificationFailure,
} from "../error/provider-errors.js";
import { providerFetch } from "./provider-fetch.js";

/** Use the official Claude SDK for model discovery and a bounded real inference check. */
export class AnthropicConnectionVerifier implements ConnectionVerifier {
  // ===========================================
  // Construction
  // ===========================================

  /** Allow transport substitution in tests without changing the provider policy. */
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  // ===========================================
  // Verification
  // ===========================================

  /** Prefer a small available Claude model unless the owner supplied one. */
  async verify({ credential, model }: VerificationInput): Promise<string> {
    try {
      const client = new Anthropic({
        apiKey: credential.apiKey ?? "",
        maxRetries: 0,
        timeout: 30_000,
        fetch: providerFetch(this.fetcher),
      });
      if (!model) {
        const models = (await client.models.list({ limit: 100 })).data;
        model =
          models.find((item) => item.id.includes("haiku"))?.id ??
          models[0]?.id ??
          null;
      }
      if (!model)
        throw new ProviderVerificationError(
          "No models are available for this API key.",
        );
      const result = await client.messages.create({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with OK." }],
      });
      if (
        result.type !== "message" ||
        !["end_turn", "max_tokens"].includes(result.stop_reason ?? "") ||
        !result.content.some((part) => part.type === "text" && part.text.trim())
      ) {
        throw new ProviderVerificationError(
          "The provider returned no completed text. Choose a text model and check again.",
        );
      }
      return model;
    } catch (error) {
      throw verificationFailure(error);
    }
  }
}
