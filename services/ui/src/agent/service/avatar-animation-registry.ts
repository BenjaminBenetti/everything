import type { ComponentType } from "react";
import type {
  AvatarAnimationLookup,
  AvatarAnimationProps,
} from "../interface/avatar-animation.js";

/** Register independent effects at composition time without changing avatar rendering. */
export class AvatarAnimationRegistry implements AvatarAnimationLookup {
  // ===========================================
  // Registered effects
  // ===========================================
  private readonly animations = new Map<
    string,
    {
      animation: ComponentType<AvatarAnimationProps>;
      still?: ComponentType<AvatarAnimationProps>;
    }
  >();

  // ===========================================
  // Registration and lookup
  // ===========================================
  /** Add a named effect and optional still pose, rejecting accidental replacement. */
  register(
    name: string,
    animation: ComponentType<AvatarAnimationProps>,
    still?: ComponentType<AvatarAnimationProps>,
  ): void {
    if (!name.trim() || this.animations.has(name)) {
      throw new Error(
        `Avatar animation names must be unique and nonempty: ${name}`,
      );
    }
    this.animations.set(name, { animation, ...(still ? { still } : {}) });
  }

  /** Keep unsupported effects optional so the underlying artwork remains visible. */
  get(name: string): ComponentType<AvatarAnimationProps> | undefined {
    return this.animations.get(name)?.animation;
  }

  /** Preserve meaningful props, such as a laptop, while animation playback is stopped. */
  getStill(name: string): ComponentType<AvatarAnimationProps> | undefined {
    return this.animations.get(name)?.still;
  }
}
