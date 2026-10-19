import type { AgentAvatarId } from "@everything/agent-contracts/avatar";
import { avatarFace } from "./avatar-face.js";

/**
 * The thinking pose shrinks the artwork and moves it `shift` percent toward the lower left, leaving
 * room for the thought cloud. `avatar-animation.css` applies the same `translate(-6%, 6%) scale(0.86)`.
 */
export const avatarThinkingArtwork = { scale: 0.86, shift: 6 } as const;

/** Width and height of the shared paw outline in the 128 × 128 artwork. */
export const avatarThinkingPawSize = 14;

/** Map a point in the original artwork to where the thinking pose draws it. */
function placed(x: number, y: number): { x: number; y: number } {
  const { scale, shift } = avatarThinkingArtwork;
  return {
    x: 64 + (x - 64) * scale - (shift / 100) * 128,
    y: 64 + (y - 64) * scale + (shift / 100) * 128,
  };
}

/** Rest the paw just below the mouth, slightly off-centre, on the moved artwork. */
export function avatarThinkingPaw(avatarId: AgentAvatarId): {
  x: number;
  y: number;
} {
  const { middle, spacing, chin } = avatarFace(avatarId);
  const point = placed(middle + spacing * 0.35, chin);
  return {
    x: Math.round(point.x - avatarThinkingPawSize / 2),
    y: Math.round(point.y - 2),
  };
}
