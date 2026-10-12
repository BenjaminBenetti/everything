import type { AgentAvatarId } from "@everything/agent-contracts/avatar";
import { useState } from "react";
import { teammateAvatar } from "../model/teammate-avatars.js";
import { AvatarAnimation } from "./avatar-animation.js";

/** Render saved artwork with an optional registered effect; every entry point defaults to still. */
export function TeammateAvatar({
  avatarId,
  small = false,
  animation,
  animationSeed,
}: {
  avatarId?: AgentAvatarId;
  small?: boolean;
  animation?: string;
  animationSeed?: string;
}) {
  const avatar = teammateAvatar(avatarId);
  const [loadedSrc, setLoadedSrc] = useState<string>();
  return (
    <span
      className={`teammate-avatar ${small ? "mini-avatar" : "avatar"}`}
      data-avatar-id={avatar.id}
      aria-hidden="true"
    >
      <span className="teammate-avatar-artwork">
        <img
          src={avatar.src}
          alt=""
          width={64}
          height={64}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoadedSrc(avatar.src)}
          onError={() => setLoadedSrc(undefined)}
        />
        {animation && loadedSrc === avatar.src && (
          <AvatarAnimation
            name={animation}
            avatarId={avatar.id}
            seed={animationSeed ?? avatar.id}
          />
        )}
      </span>
    </span>
  );
}
