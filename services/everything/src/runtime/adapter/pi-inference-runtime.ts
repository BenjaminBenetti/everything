import {
  InMemoryCredentialStore,
  lazyStream,
  type Model,
} from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { InferenceSelection } from "@everything/provider-contracts/inference";
import type { ProviderAccess } from "../../provider/interface/provider-access.js";
import type { ProviderModels } from "../../provider/interface/provider-models.js";
import { providerFetch } from "../../provider/adapter/provider-fetch.js";
import type {
  InferenceRuntime,
  InferenceRuntimeFactory,
  RuntimeModelCatalog,
} from "../interface/inference-runtime.js";
import type { ProviderId } from "@everything/provider-contracts";

/** Adapt owner-scoped connections to Pi without writing decrypted credentials to workspace files. */
export class PiInferenceRuntimeFactory implements InferenceRuntimeFactory {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive account access, selection validation, model metadata, and replaceable transport. */
  constructor(
    private readonly connections: ProviderAccess,
    private readonly choices: Pick<ProviderModels, "validate">,
    private readonly capabilities: RuntimeModelCatalog,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  // ===========================================
  // Runtime preparation
  // ===========================================

  /** Pin the selected model and refresh connection access before every inference request. */
  async create(
    ownerId: string,
    selection: InferenceSelection,
  ): Promise<InferenceRuntime> {
    await this.choices.validate(ownerId, selection);
    const connection = await this.connections.access(
      ownerId,
      selection.provider,
    );
    const baseUrl = this.address(selection.provider, connection.baseUrl);
    const model = this.capabilities.resolve(
      selection.provider,
      selection.model,
      baseUrl,
    );
    const models = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    models.registerProvider(model.provider, {
      api: model.api,
      baseUrl,
      models: [model],
      /** Resolve only the saved owner's credentials, including renewed OAuth grants and disconnects. */
      streamSimple: (selected, context, options) =>
        lazyStream(selected, async () => {
          const current = await this.connections.access(
            ownerId,
            selection.provider,
          );
          const key =
            selection.provider === "chatgpt"
              ? current.credential.accessToken!
              : (current.credential.apiKey ?? "");
          const target = {
            ...selected,
            baseUrl: this.address(selection.provider, current.baseUrl),
          };
          const requestOptions = {
            ...options,
            apiKey: key || "local",
            /** Do not invent authentication for keyless local servers or follow credential-bearing redirects. */
            fetch: ((input, init) => {
              const headers = new Headers(init?.headers);
              if (!key) headers.delete("authorization");
              return providerFetch(this.fetcher)(input, { ...init, headers });
            }) satisfies typeof fetch,
          };
          if (selection.provider === "anthropic")
            return anthropicStream(
              target as Model<"anthropic-messages">,
              context,
              requestOptions,
            );
          if (selection.provider === "chatgpt")
            return responsesStream(
              { ...target, api: "openai-responses" },
              context,
              requestOptions,
            );
          return completionsStream(
            { ...target, api: "openai-completions" },
            context,
            requestOptions,
          );
        }),
    });
    // Pi checks availability before opening a session; request authentication is resolved above.
    await models.setRuntimeApiKey(model.provider, "owner-scoped-connection");
    return { models, model: models.getModel(model.provider, model.id)! };
  }

  /** Official SDKs expect different base paths; only compatible servers accept a custom address. */
  private address(provider: ProviderId, configured: string | null): string {
    if (provider === "chatgpt") return "https://api.openai.com/v1";
    if (provider === "anthropic") return "https://api.anthropic.com";
    return configured!;
  }
}
