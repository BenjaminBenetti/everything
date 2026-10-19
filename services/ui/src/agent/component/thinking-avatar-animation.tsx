import type { CSSProperties } from "react";
import type { AvatarAnimationProps } from "../interface/avatar-animation.js";
import { avatarTypingColors } from "../model/avatar-typing-colors.js";
import { avatarAnimationTiming } from "../model/avatar-animation-timing.js";
import { avatarThinkingPaw } from "../model/avatar-thinking-pose.js";
import { AvatarThoughtCloud } from "./avatar-thought-cloud.js";

/** Rest a paw on the teammate's chin under a shared thought cloud; the paw scratches while motion plays. */
export function ThinkingAvatarAnimation({
  avatarId,
  seed,
}: AvatarAnimationProps) {
  const { delay } = avatarAnimationTiming(seed);
  const paw = avatarThinkingPaw(avatarId);
  return (
    <svg
      className="avatar-thinking-scene"
      viewBox="0 0 128 128"
      focusable="false"
      shapeRendering="crispEdges"
      style={
        { "--avatar-thinking-delay": `${delay % 2400}ms` } as CSSProperties
      }
    >
      <AvatarThoughtCloud />
      <g transform={`translate(${paw.x} ${paw.y})`}>
        <g
          className="avatar-thinking-paw"
          fill={avatarTypingColors[avatarId]}
          stroke="#382536"
        >
          <path d="M0 3h3V0h8v3h3v8h-3v3H2v-3H0z" strokeWidth="2" />
          <path d="M5 1v4M9 1v4" fill="none" strokeWidth="1.5" />
        </g>
      </g>
    </svg>
  );
}
