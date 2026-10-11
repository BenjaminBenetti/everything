/** Small transport abstraction consumed by domain adapters. */
export interface JsonTransport {
  /** Make an authenticated same-origin JSON request. */
  request<T>(path: string, options?: RequestInit): Promise<T>;
}
