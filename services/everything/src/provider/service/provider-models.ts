import type { ProviderId } from "@everything/provider-contracts";
import type {
  InferenceSelection,
  ProviderModel,
} from "@everything/provider-contracts/inference";
import type { ProviderAccess } from "../interface/provider-access.js";
import type {
  DiscoveredModel,
  ModelCapabilities,
  ProviderModelDiscovery,
  ProviderModels,
} from "../interface/provider-models.js";
import {
  FastModeUnsupportedError,
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
    return (await this.discover(ownerId, provider)).map((model) =>
      this.capabilities.describe(provider, model),
    );
  }

  /** Validate the complete selection again at save time, including its ownership scope. */
  async validate(
    ownerId: string,
    selection: InferenceSelection,
  ): Promise<void> {
    await this.select(ownerId, selection);
  }

  /**
   * Validate a selection against a fresh catalog, returning the model with the limits it reports.
   * Selections saved before speeds existed mean standard.
   */
  async select(
    ownerId: string,
    selection: InferenceSelection,
  ): Promise<DiscoveredModel> {
    const model = (await this.discover(ownerId, selection.provider)).find(
      (item) => item.id === selection.model,
    );
    if (!model) throw new InferenceSelectionError();
    const { efforts, speeds } = this.capabilities.describe(
      selection.provider,
      model,
    );
    if (!efforts.includes(selection.effort))
      throw new InferenceSelectionError();
    if (!speeds.includes(selection.speed ?? "standard"))
      throw new FastModeUnsupportedError();
    return model;
  }

  // ===========================================
  // Discovery
  // ===========================================

  /** Discover the owner's models, hiding upstream failure details. */
  private async discover(
    ownerId: string,
    provider: ProviderId,
  ): Promise<DiscoveredModel[]> {
    const connection = await this.connections.access(ownerId, provider);
    try {
      return await this.discovery.discover(provider, connection);
    } catch {
      throw new ProviderModelsError();
    }
  }
}
