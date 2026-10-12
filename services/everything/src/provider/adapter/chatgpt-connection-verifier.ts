import OpenAI from "openai";
import type {
  ConnectionVerifier,
  VerificationInput,
} from "../interface/connection-verifier.js";
import {
  ProviderVerificationError,
  verificationFailure,
} from "../error/provider-errors.js";
import { providerFetch } from "./provider-fetch.js";

/** Check actual ChatGPT plan access through the documented public Responses endpoint. */
export class ChatGptConnectionVerifier implements ConnectionVerifier {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject transport while keeping ChatGPT credentials confined to its official endpoint. */
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  // ===========================================
  // Verification
  // ===========================================

  /** A model catalog or HTTP 200 alone is insufficient: require response.completed. */
  async verify({ credential }: VerificationInput): Promise<string> {
    try {
      const transport = providerFetch(this.fetcher);
      const catalogResponse = await transport(
        "https://api.openai.com/v1/models",
        {
          headers: { authorization: `Bearer ${credential.accessToken}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!catalogResponse.ok) throw { status: catalogResponse.status };
      const catalog = (await catalogResponse.json()) as {
        models?: { slug: string; visibility: string }[];
      };
      const models =
        catalog.models?.filter(
          (model) =>
            model.visibility === "list" && typeof model.slug === "string",
        ) ?? [];
      const model =
        models.find((item) => /mini|nano|luna/i.test(item.slug))?.slug ??
        models[0]?.slug;
      if (!model)
        throw new ProviderVerificationError(
          "No ChatGPT models are available. Check your plan and app access in ChatGPT.",
        );
      const client = new OpenAI({
        apiKey: credential.accessToken!,
        baseURL: "https://api.openai.com/v1",
        maxRetries: 0,
        timeout: 30_000,
        fetch: transport,
      });
      const stream = await client.responses.create(
        {
          model,
          input: [{ role: "user", content: "Reply with OK." }],
          store: false,
          stream: true,
        },
        { signal: AbortSignal.timeout(30_000) },
      );
      let completed = false;
      let text = "";
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") text += event.delta;
        if (event.type === "response.completed") completed = true;
        if (
          ["response.failed", "response.incomplete", "error"].includes(
            event.type,
          )
        )
          throw new ProviderVerificationError(
            "ChatGPT could not complete the check. Review app access and available usage in ChatGPT, then try again.",
          );
      }
      if (!completed || !text.trim())
        throw new ProviderVerificationError(
          "ChatGPT did not finish the connection check. Please try again.",
        );
      return model;
    } catch (error) {
      throw verificationFailure(error);
    }
  }
}
