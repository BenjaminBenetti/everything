/** One pixel-art laptop asset shared by every character's typing pose. */
export function AvatarLaptop() {
  return (
    <g className="avatar-laptop">
      <path d="M32 113h86v8H32z" fill="#382536" opacity=".3" />
      <path d="M43 91h48l26 20v8H28v-8z" fill="#293344" />
      <path d="M45 95h43l21 16H35z" fill="#b8cedd" />
      <path d="M36 112h72v3H36z" fill="#8198ac" />
      <path d="M48 98h29v3H48zm-5 5h40v3H43z" fill="#50677d" />
      <path d="M56 109h17v3H56z" fill="#e5eff3" />
      <path d="M79 68h39v4h4v33h-4v4H75V72h4z" fill="#293344" />
      <path d="M80 73h36v30H80z" fill="#8aa5bc" />
      <path d="M84 77h28v22H84z" fill="#22384a" />
      <path d="M88 82h11v3H88zm0 6h18v3H88z" fill="#92dfc4" />
      <path
        className="avatar-laptop-cursor"
        d="M88 94h4v2h-4z"
        fill="#f3d288"
      />
      <path d="M83 73h30v2H83z" fill="#dce9f1" />
    </g>
  );
}
