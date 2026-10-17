/** The versions of the chart published at its configured location. */
export interface ChartVersions {
  /** List every published version; `fresh` skips any cached answer. */
  published(options?: { readonly fresh?: boolean }): Promise<string[]>;
}
