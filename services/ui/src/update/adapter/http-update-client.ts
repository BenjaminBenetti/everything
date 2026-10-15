import type { UpdateCount, UpdatePage } from "@everything/update-contracts";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import type { UpdateClient } from "../interface/update-client.js";

/** Map update operations to the authenticated, side-effect-free update endpoints. */
export class HttpUpdateClient implements UpdateClient {
  // ===========================================
  // Construction
  // ===========================================

  /** Share the application's cookie and error handling policy. */
  constructor(private readonly transport: JsonTransport) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Page seen history using an owned update ID as its stable cursor. */
  seen(before?: string, signal?: AbortSignal): Promise<UpdatePage> {
    const query = before ? `?${new URLSearchParams({ before })}` : "";
    return this.transport.request(
      `/v1/updates/seen${query}`,
      signal ? { signal } : {},
    );
  }

  /** Page with the last update ID seen; the cursor stays valid after updates are read. */
  list(before?: string, signal?: AbortSignal): Promise<UpdatePage> {
    const query = before ? `?${new URLSearchParams({ before })}` : "";
    return this.transport.request(
      `/v1/updates${query}`,
      signal ? { signal } : {},
    );
  }

  /** Read only the unread total, for the navigation badge. */
  count(signal?: AbortSignal): Promise<UpdateCount> {
    return this.transport.request(
      "/v1/updates/count",
      signal ? { signal } : {},
    );
  }
}
