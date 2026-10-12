/** Give each teammate a repeatable rhythm, including teammates sharing the same artwork. */
export function avatarAnimationTiming(seed: string): {
  duration: number;
  delay: number;
} {
  let hash = 2166136261;
  for (const character of seed) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  const duration = 5800 + (hash % 2400);
  return { duration, delay: -((hash >>> 8) % duration) };
}
