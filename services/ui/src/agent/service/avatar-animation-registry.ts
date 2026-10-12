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
    ComponentType<AvatarAnimationProps>
  >();

  // ===========================================
  // Registration and lookup
  // ===========================================
  /** Add a named effect, rejecting accidental replacement of an existing animation. */
  register(name: string, animation: ComponentType<AvatarAnimationProps>): void {
    if (!name.trim() || this.animations.has(name)) {
      throw new Error(
        `Avatar animation names must be unique and nonempty: ${name}`,
      );
    }
    this.animations.set(name, animation);
  }

  /** Keep unsupported effects optional so the underlying artwork remains visible. */
  get(name: string): ComponentType<AvatarAnimationProps> | undefined {
    return this.animations.get(name);
  }
}
