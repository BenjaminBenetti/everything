import type { CSSProperties } from "react";
import type { AvatarAnimationProps } from "../interface/avatar-animation.js";
import { avatarTypingColors } from "../model/avatar-typing-colors.js";
import { avatarAnimationTiming } from "../model/avatar-animation-timing.js";
import {
  avatarWatchingGlass,
  avatarWatchingLids,
} from "../model/avatar-watching-pose.js";
import { AvatarMagnifier } from "./avatar-magnifier.js";

/** Lower the teammate's eyes onto a small magnifying glass held below its chin; the glass scans while motion plays. */
export function WatchingAvatarAnimation({
  avatarId,
  seed,
}: AvatarAnimationProps) {
  const { delay } = avatarAnimationTiming(seed);
  const glass = avatarWatchingGlass(avatarId);
  return (
    <svg
      className="avatar-watching-scene"
      viewBox="0 0 128 128"
      focusable="false"
      shapeRendering="crispEdges"
      style={
        { "--avatar-watching-delay": `${delay % 3200}ms` } as CSSProperties
      }
    >
      {avatarWatchingLids(avatarId).map(
        ({ x, y, width, height, lid }, index) => (
          <g key={index}>
            <rect x={x} y={y} width={width} height={height} fill={lid} />
            <path
              d={`M${x + 1} ${y + height}h${width - 2}`}
              stroke="#382536"
              strokeWidth={2}
            />
          </g>
        ),
      )}
      <g transform={`translate(${glass.x} ${glass.y})`}>
        <g className="avatar-watching-glass">
          <AvatarMagnifier paw={avatarTypingColors[avatarId]} />
        </g>
      </g>
    </svg>
  );
}
