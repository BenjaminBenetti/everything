import type { AgentAvatarId } from "@everything/agent-contracts/avatar";
import { avatarIdleEyes } from "./avatar-idle-eyes.js";

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

/**
 * Rest the paw just below the mouth, slightly off-centre, using the artist-aligned eye regions:
 * the gap below the eyes grows with their spacing, within limits that suit every bundled character.
 */
export function avatarThinkingPaw(avatarId: AgentAvatarId): {
  x: number;
  y: number;
} {
  const eyes = avatarIdleEyes[avatarId];
  const centers = eyes.map((eye) => eye.x + eye.width / 2);
  const middle =
    centers.reduce((sum, center) => sum + center, 0) / centers.length;
  // The moon has one open eye; its width stands in for the spacing between two.
  const spacing =
    centers.length > 1
      ? Math.abs(centers[1]! - centers[0]!)
      : eyes[0]!.width * 2.2;
  const bottom = Math.max(...eyes.map((eye) => eye.y + eye.height));
  const chin = placed(
    middle + spacing * 0.35,
    bottom + Math.min(14, Math.max(9, spacing * 0.45)),
  );
  return {
    x: Math.round(chin.x - avatarThinkingPawSize / 2),
    y: Math.round(chin.y - 2),
  };
}
