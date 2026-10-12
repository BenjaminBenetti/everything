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

// Leave room for reasoning before the short answer, while bounding the check's cost.
const checkTokenLimit = 1024;
const checkTimeoutMs = 30_000;

/** Verify servers implementing the OpenAI chat-completions contract, including local models. */
export class CompatibleConnectionVerifier implements ConnectionVerifier {
  // ===========================================
  // Construction
  // ===========================================

  /** Accept a replaceable transport for tests and deployment networking. */
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  // ===========================================
  // Verification
  // ===========================================

  /** Discover a text model and require an actual response from the supplied API address. */
  async verify({
    credential,
    baseUrl,
    model,
  }: VerificationInput): Promise<string> {
    let listingModels = !model;
    try {
      const key = credential.apiKey ?? "";
      const transport = providerFetch(this.fetcher);
      const client = new OpenAI({
        apiKey: key || "local",
        baseURL: baseUrl!,
        maxRetries: 0,
        timeout: checkTimeoutMs,
        /** Keyless local servers receive no invented authorization header. */
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          if (!key) headers.delete("authorization");
          return transport(input, { ...init, headers });
        },
      });
      if (!model) {
        const models = (await client.models.list())?.data;
        if (!Array.isArray(models))
          throw new ProviderVerificationError(
            "The server returned an unexpected model list. Check the API base address, or enter a model name under Advanced settings.",
          );
        const candidates = models.filter(
          (item) =>
            typeof item?.id === "string" &&
            !/embed|rerank|moderation|whisper|tts|image|dall-e|audio/i.test(
              item.id,
            ),
        );
        model =
          candidates.find((item) => /mini|small|nano/i.test(item.id))?.id ??
          candidates[0]?.id ??
          null;
      }
      if (!model)
        throw new ProviderVerificationError(
          "No text models were found. Enter a model name under advanced settings.",
        );
      listingModels = false;
      const result = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: checkTokenLimit,
      });
      this.requireText(result);
      return model;
    } catch (error) {
      if (error instanceof OpenAI.APIConnectionTimeoutError)
        throw new ProviderVerificationError(
          `The server did not finish ${listingModels ? "listing models" : "the test response"} within ${checkTimeoutMs / 1000} seconds. Check that the model server is ready, or try a faster model.`,
        );
      if (error instanceof OpenAI.APIConnectionError)
        throw new ProviderVerificationError(
          "Everything could not connect to the API. Check that the server is running and its address is reachable from Everything, including the port and HTTPS settings.",
        );
      if (error instanceof SyntaxError)
        throw new ProviderVerificationError(
          "The server returned invalid JSON. Check that the API base address points to an OpenAI-compatible API.",
        );
      if (
        listingModels &&
        (error as { status?: number } | null)?.status === 404
      )
        throw new ProviderVerificationError(
          "The model-list endpoint returned HTTP 404. Check the API base address, or enter a model name under Advanced settings to skip model discovery.",
        );
      throw verificationFailure(error);
    }
  }

  // ===========================================
  // Response validation
  // ===========================================

  /** Explain protocol outcomes without exposing generated text, reasoning, or upstream errors. */
  private requireText(result: OpenAI.Chat.Completions.ChatCompletion): void {
    const choice = Array.isArray(result?.choices)
      ? result.choices[0]
      : undefined;
    const message = choice?.message;
    if (!message || typeof message !== "object")
      throw new ProviderVerificationError(
        "The server returned no chat message in its response. Check that the API base address supports OpenAI-compatible /chat/completions.",
      );
    if (choice.finish_reason === "content_filter" || message.refusal)
      throw new ProviderVerificationError(
        "The model refused or filtered the connection test. Check its content settings or try another model.",
      );
    if (["tool_calls", "function_call"].includes(choice.finish_reason))
      throw new ProviderVerificationError(
        "The model requested a tool instead of returning a text answer. Check the server's chat template or choose a model configured for text chat.",
      );
    if (!["stop", "length"].includes(choice.finish_reason))
      throw new ProviderVerificationError(
        "The server returned a chat response without a supported completion status. Check its compatibility with the OpenAI chat completions API.",
      );
    if (typeof message.content === "string" && message.content.trim()) return;
    if (message.content != null && typeof message.content !== "string")
      throw new ProviderVerificationError(
        "The server returned chat content in an unexpected format. The connection test needs a text answer from the OpenAI-compatible chat completions endpoint.",
      );
    const reasoning = message as {
      reasoning_content?: unknown;
      reasoning?: unknown;
    };
    const hasReasoning =
      (typeof reasoning.reasoning_content === "string" &&
        !!reasoning.reasoning_content.trim()) ||
      (typeof reasoning.reasoning === "string" &&
        !!reasoning.reasoning.trim()) ||
      (result.usage?.completion_tokens_details?.reasoning_tokens ?? 0) > 0;
    if (choice.finish_reason === "length")
      throw new ProviderVerificationError(
        `${hasReasoning ? "The model returned reasoning but no answer" : "The model returned no text"} before reaching its output limit. The check allows up to ${checkTokenLimit} tokens. Reduce the model's reasoning budget on your server or try another model.`,
      );
    throw new ProviderVerificationError(
      hasReasoning
        ? "The model returned reasoning but no text answer. Check the server's chat template or try another model."
        : "The server completed the request but returned an empty message. Check the model's chat template or try another text model.",
    );
  }
}
