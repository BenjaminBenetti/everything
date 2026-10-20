import type { AgentAvatarId } from "@everything/agent-contracts/avatar";
import type { AvatarEye } from "../interface/avatar-animation.js";
import { avatarFace } from "./avatar-face.js";
import { avatarIdleEyes } from "./avatar-idle-eyes.js";

/** Outer radius of the shared magnifying glass's lens in the 128 × 128 artwork. */
export const avatarWatchingLensRadius = 10.5;

/** How far the handle and the paw holding it reach below and right of the lens centre. */
export const avatarWatchingReach = 25;

/**
 * Hold the lens just below the mouth, its handle running down and right, inside the artwork. A face
 * too low to fit the lens beneath it holds the lens beside it instead, clear of the eyes.
 */
export function avatarWatchingGlass(avatarId: AgentAvatarId): {
  x: number;
  y: number;
} {
  const { middle, spacing, eyesBottom, chin } = avatarFace(avatarId);
  const limit = 128 - avatarWatchingReach - 1;
  const y = Math.min(limit, chin + 9);
  const eyesRight = Math.max(
    ...avatarIdleEyes[avatarId].map((eye) => eye.x + eye.width),
  );
  const beside = y - avatarWatchingLensRadius <= eyesBottom;
  const x = beside
    ? eyesRight + avatarWatchingLensRadius + 1
    : middle + spacing * 0.12;
  return { x: Math.round(Math.min(limit, x)), y: Math.round(y) };
}

/** Lower each eye's upper lid halfway, in the face's own colour, so the character looks down. */
export function avatarWatchingLids(avatarId: AgentAvatarId): AvatarEye[] {
  return avatarIdleEyes[avatarId].map((eye) => ({
    ...eye,
    height: Math.ceil(eye.height / 2),
  }));
}
