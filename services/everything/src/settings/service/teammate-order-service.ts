import {
  defaultTeammateOrder,
  type TeammateOrder,
} from "@everything/settings-contracts";
import type { TeammateOrderOperations } from "../interface/teammate-order.js";
import type { GeneralSettingsStore } from "../interface/general-settings-repository.js";

/** Own the signed-in owner's teammate order, stored with their other general preferences. */
export class TeammateOrderService implements TeammateOrderOperations {
  // ===========================================
  // Construction
  // ===========================================

  /** Accept only the settings storage operations this service needs. */
  constructor(private readonly settings: GeneralSettingsStore) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read without creating a record, keeping creation order until the owner rearranges their team. */
  async read(ownerId: string): Promise<TeammateOrder> {
    const [saved] = await this.settings.list({ ownerId });
    return {
      teammateIds: [
        ...(saved?.teammateIds ?? defaultTeammateOrder.teammateIds),
      ],
    };
  }

  /** Replace only the current owner's order; browsers place teammates it doesn't list. */
  async update(ownerId: string, order: TeammateOrder): Promise<TeammateOrder> {
    await this.settings.save({ ownerId }, { teammateIds: order.teammateIds });
    return { teammateIds: [...order.teammateIds] };
  }
}
