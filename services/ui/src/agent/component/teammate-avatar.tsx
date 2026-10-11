import type { AgentAvatarId } from "@everything/agent-contracts/avatar";
import { teammateAvatar } from "../model/teammate-avatars.js";

/** Render the same saved artwork at every teammate entry point without duplicating its label. */
export function TeammateAvatar({
  avatarId,
  small = false,
}: {
  avatarId?: AgentAvatarId;
  small?: boolean;
}) {
  const avatar = teammateAvatar(avatarId);
  return (
    <span
      className={`teammate-avatar ${small ? "mini-avatar" : "avatar"}`}
      data-avatar-id={avatar.id}
      aria-hidden="true"
    >
      <img
        src={avatar.src}
        alt=""
        width={64}
        height={64}
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    </span>
  );
}
