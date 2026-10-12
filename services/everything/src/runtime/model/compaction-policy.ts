/** Leave space for replies and summaries while bounding retained context for smaller models. */
export function compactionPolicy(contextWindow: number) {
  const quarter = Math.max(1, Math.floor(contextWindow / 4));
  return {
    enabled: true,
    reserveTokens: Math.min(16384, quarter),
    keepRecentTokens: Math.min(20000, quarter),
  };
}
