import type { CSSProperties } from "react";
import type { AvatarAnimationProps } from "../interface/avatar-animation.js";
import { avatarTypingColors } from "../model/avatar-typing-colors.js";
import { avatarAnimationTiming } from "../model/avatar-animation-timing.js";
import { AvatarLaptop } from "./avatar-laptop.js";

/** Layer a shared laptop and alternating typing hands over the teammate's original artwork. */
export function TypingAvatarAnimation({
  avatarId,
  seed,
}: AvatarAnimationProps) {
  const { delay } = avatarAnimationTiming(seed);
  return (
    <svg
      className="avatar-typing-scene"
      viewBox="0 0 128 128"
      focusable="false"
      shapeRendering="crispEdges"
      style={{ "--avatar-typing-delay": `${delay % 600}ms` } as CSSProperties}
    >
      <AvatarLaptop />
      <g fill={avatarTypingColors[avatarId]} stroke="#382536" strokeWidth="2">
        <g transform="translate(40 86)">
          <path
            className="avatar-typing-hand hand-left"
            d="M0 3h3V0h8v3h3v8h-3v3H2v-3H0z"
          />
        </g>
        <g transform="translate(61 88)">
          <path
            className="avatar-typing-hand hand-right"
            d="M0 3h3V0h8v3h3v8h-3v3H2v-3H0z"
          />
        </g>
      </g>
    </svg>
  );
}
