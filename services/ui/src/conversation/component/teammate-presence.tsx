import { useEffect, useId, useState } from "react";
import type { Agent } from "@everything/agent-contracts";
import { TeammateAvatar } from "../../agent/component/teammate-avatar.js";
import {
  monitorCountLabel,
  type MainActivity,
} from "../model/main-activity.js";

/**
 * Pose the main teammate's avatar for its main session's activity; at rest it keeps the caller's
 * effect, such as the card's blink. While it watches monitors, the avatar takes keyboard focus and
 * describes their count on hover, focus, or touch, as card indicators do. The avatar element stays
 * mounted across states, so its size and loaded artwork never change.
 */
export function TeammatePresence({
  agent,
  activity,
  small = false,
  resting,
}: {
  agent: Pick<Agent, "id" | "name" | "avatarId">;
  activity: MainActivity;
  small?: boolean;
  resting?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const watching = activity.kind === "watching";
  useEffect(() => {
    if (!watching) setOpen(false);
  }, [watching]);
  const animation = activity.kind === "idle" ? resting : activity.kind;
  return (
    <span
      className="teammate-presence"
      onMouseEnter={() => setOpen(watching)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement))
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <span
        className="teammate-presence-trigger"
        {...(watching
          ? {
              role: "img",
              "aria-label": `${agent.name} is watching monitors`,
              "aria-describedby": open ? id : undefined,
              tabIndex: 0,
              onFocus: () => setOpen(true),
              onBlur: () => setOpen(false),
              onClick: () => setOpen(true),
            }
          : {})}
      >
        <TeammateAvatar
          avatarId={agent.avatarId}
          small={small}
          {...(animation ? { animation } : {})}
          animationSeed={agent.id}
        />
      </span>
      {activity.kind === "watching" && open && (
        <span id={id} role="tooltip" className="teammate-presence-tooltip">
          {monitorCountLabel(activity.monitors)}
        </span>
      )}
    </span>
  );
}
