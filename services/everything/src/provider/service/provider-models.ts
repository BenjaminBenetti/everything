import type { ProviderId } from "@everything/provider-contracts";
import type {
  InferenceSelection,
  ProviderModel,
} from "@everything/provider-contracts/inference";
import type { ProviderAccess } from "../interface/provider-access.js";
import type {
  ModelCapabilities,
  ProviderModelDiscovery,
  ProviderModels,
} from "../interface/provider-models.js";
import {
  InferenceSelectionError,
  ProviderModelsError,
} from "../error/provider-errors.js";

/** Combine account availability with runtime capabilities without making inference requests. */
export class ProviderModelService implements ProviderModels {
  // ===========================================
  // Construction
  // ===========================================

  /** Keep credentials, provider protocols, and runtime metadata behind focused interfaces. */
  constructor(
    private readonly connections: ProviderAccess,
    private readonly discovery: ProviderModelDiscovery,
    private readonly capabilities: ModelCapabilities,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Fetch the owner's catalog; expose neither credentials nor upstream failure details. */
  async list(ownerId: string, provider: ProviderId): Promise<ProviderModel[]> {
    const connection = await this.connections.access(ownerId, provider);
    try {
      const models = await this.discovery.discover(provider, connection);
      return models.map((model) => this.capabilities.describe(provider, model));
    } catch {
      throw new ProviderModelsError();
    }
  }

  /** Validate the complete selection again at save time, including its ownership scope. */
  async validate(
    ownerId: string,
    selection: InferenceSelection,
  ): Promise<void> {
    const model = (await this.list(ownerId, selection.provider)).find(
      (item) => item.id === selection.model,
    );
    if (!model?.efforts.includes(selection.effort))
      throw new InferenceSelectionError();
  }
}
