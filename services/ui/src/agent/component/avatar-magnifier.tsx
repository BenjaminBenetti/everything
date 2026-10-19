import { avatarWatchingLensRadius } from "../model/avatar-watching-pose.js";

/** One pixel-art magnifying glass, centred on its lens, held by a paw at the end of its handle. */
export function AvatarMagnifier({ paw }: { paw: string }) {
  return (
    <g className="avatar-magnifier">
      <path
        d="M7 7l8 8"
        stroke="#382536"
        strokeWidth="6.5"
        strokeLinecap="square"
      />
      <path
        d="M7.5 7.5l7 7"
        stroke="#9a6b3f"
        strokeWidth="3.5"
        strokeLinecap="square"
      />
      <circle
        r={avatarWatchingLensRadius}
        fill="#cfeeff"
        fillOpacity=".55"
        stroke="#382536"
        strokeWidth="2.5"
      />
      <circle
        r={avatarWatchingLensRadius - 2.1}
        fill="none"
        stroke="#e2b85c"
        strokeWidth="2.2"
      />
      <path
        className="avatar-magnifier-glint"
        d="M-5 -2v-3h3"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2"
      />
      <g transform="translate(11 11)" fill={paw} stroke="#382536">
        <path d="M0 3h3V0h8v3h3v8h-3v3H2v-3H0z" strokeWidth="2" />
        <path d="M5 1v4M9 1v4" fill="none" strokeWidth="1.5" />
      </g>
    </g>
  );
}
