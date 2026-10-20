import type { AgentAvatarId } from "@everything/agent-contracts/avatar";
import { avatarIdleEyes } from "./avatar-idle-eyes.js";

/** Where a character's face sits in its original 128 × 128 artwork, from its artist-aligned eye regions. */
export interface AvatarFace {
  /** Horizontal centre between the eyes. */
  readonly middle: number;
  /** Distance between the eye centres, standing in for the face's size. */
  readonly spacing: number;
  /** Lowest edge of the eyes. */
  readonly eyesBottom: number;
  /** Just below the mouth, where a paw or a held object rests. */
  readonly chin: number;
}

/**
 * Estimate the face from the eye regions: the gap below the eyes grows with their spacing, within
 * limits that suit every bundled character.
 */
export function avatarFace(avatarId: AgentAvatarId): AvatarFace {
  const eyes = avatarIdleEyes[avatarId];
  const centers = eyes.map((eye) => eye.x + eye.width / 2);
  const middle =
    centers.reduce((sum, center) => sum + center, 0) / centers.length;
  // The moon has one open eye; its width stands in for the spacing between two.
  const spacing =
    centers.length > 1
      ? Math.abs(centers[1]! - centers[0]!)
      : eyes[0]!.width * 2.2;
  const eyesBottom = Math.max(...eyes.map((eye) => eye.y + eye.height));
  return {
    middle,
    spacing,
    eyesBottom,
    chin: eyesBottom + Math.min(14, Math.max(9, spacing * 0.45)),
  };
}
