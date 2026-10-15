import type { ComponentType } from "react";
import type { AgentAvatarId } from "@everything/agent-contracts/avatar";

/** Artwork and a stable instance seed available to every registered animation. */
export interface AvatarAnimationProps {
  avatarId: AgentAvatarId;
  seed: string;
}

/** Rendering only needs to look up an animation, not change the registry. */
export interface AvatarAnimationLookup {
  /** Resolve an optional effect; unknown names retain the still artwork. */
  get(name: string): ComponentType<AvatarAnimationProps> | undefined;
  /** Resolve an optional still pose when motion is disabled or the effect is out of view. */
  getStill(name: string): ComponentType<AvatarAnimationProps> | undefined;
}

/** Pixel coordinates and face color for one eye in the 128 × 128 artwork. */
export interface AvatarEye {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly lid: string;
}
