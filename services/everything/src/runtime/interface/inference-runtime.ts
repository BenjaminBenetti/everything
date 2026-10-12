import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { InferenceSelection } from "@everything/provider-contracts/inference";
import type { ProviderId } from "@everything/provider-contracts";
import type { ModelLimits } from "../../provider/interface/provider-models.js";

/** Resolve runtime metadata independently of account availability and credentials. */
export interface RuntimeModelCatalog {
  /** Bind supported model capabilities, and any limits the provider reports, to its endpoint. */
  resolve(
    provider: ProviderId,
    id: string,
    baseUrl: string,
    limits?: ModelLimits,
  ): Model<Api>;
}

/** An isolated Pi model runtime containing one owner's explicit selection. */
export interface InferenceRuntime {
  readonly models: ModelRuntime;
  readonly model: Model<Api>;
}

/** Prepare inference independently of workspace and session persistence. */
export interface InferenceRuntimeFactory {
  /** Refuse inaccessible providers and incompatible model settings. */
  create(
    ownerId: string,
    selection: InferenceSelection,
  ): Promise<InferenceRuntime>;
}
