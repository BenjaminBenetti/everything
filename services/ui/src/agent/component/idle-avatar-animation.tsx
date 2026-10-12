import type { AvatarAnimationProps } from "../interface/avatar-animation.js";
import { avatarIdleEyes } from "../model/avatar-idle-eyes.js";
import { avatarAnimationTiming } from "../model/avatar-animation-timing.js";

/** Blink only the eyes, preserving the character silhouette and the original pixel artwork. */
export function IdleAvatarAnimation({ avatarId, seed }: AvatarAnimationProps) {
  const { duration, delay } = avatarAnimationTiming(seed);
  return (
    <svg
      className="avatar-idle-eyes"
      viewBox="0 0 128 128"
      focusable="false"
      shapeRendering="crispEdges"
      style={{
        animationDuration: `${duration}ms`,
        animationDelay: `${delay}ms`,
      }}
    >
      {avatarIdleEyes[avatarId].map(({ x, y, width, height, lid }, index) => (
        <g key={index}>
          <rect x={x} y={y} width={width} height={height} fill={lid} />
          <path
            d={`M${x + 1} ${y + Math.floor(height / 2)}v2h${width - 2}v-2`}
            fill="none"
            stroke="#382536"
            strokeWidth={2}
          />
        </g>
      ))}
    </svg>
  );
}
