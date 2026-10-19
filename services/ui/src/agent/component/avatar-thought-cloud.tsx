/** Overlapping puffs; outlines are drawn first so the fill hides their inner edges. */
const puffs = (
  <>
    <circle cx="98" cy="18" r="7" />
    <circle cx="108" cy="12" r="9" />
    <circle cx="119" cy="17" r="7" />
    <rect x="93" y="16" width="32" height="11" rx="5.5" />
  </>
);

/** One pixel-art thought cloud, trailing back toward the head, shared by every character's thinking pose. */
export function AvatarThoughtCloud() {
  return (
    <g className="avatar-thought-cloud">
      <g fill="#fbf6ee" stroke="#382536" strokeWidth="2.5">
        {puffs}
      </g>
      <g fill="#fbf6ee">{puffs}</g>
      <path d="M97 23h24" stroke="#d8d0e0" strokeWidth="2" />
      <circle
        className="avatar-thought-trail"
        cx="88"
        cy="32"
        r="3.5"
        fill="#fbf6ee"
        stroke="#382536"
        strokeWidth="2.5"
      />
      <circle
        className="avatar-thought-trail"
        cx="81"
        cy="39"
        r="2.2"
        fill="#fbf6ee"
        stroke="#382536"
        strokeWidth="2"
      />
    </g>
  );
}
