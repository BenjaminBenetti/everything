import type { CSSProperties } from "react";
import type { AvatarAnimationProps } from "../interface/avatar-animation.js";
import { avatarAnimationTiming } from "../model/avatar-animation-timing.js";
import { AvatarThoughtCloud } from "./avatar-thought-cloud.js";

/** Float a shared thought cloud beside the teammate; the cloud drifts while motion plays. */
export function ThinkingAvatarAnimation({ seed }: AvatarAnimationProps) {
  const { delay } = avatarAnimationTiming(seed);
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
    </svg>
  );
}
