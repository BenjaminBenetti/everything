import { useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { NavLink } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type Modifier,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Agent } from "@everything/agent-contracts";
import { useSaveTeammateOrder } from "../../settings/component/workspace-settings-provider.js";
import { useUpdateCount } from "../../update/hook/use-updates.js";
import {
  UpdateCountBadge,
  unreadLinkLabel,
} from "../../update/component/update-count-badge.js";
import { useAgents } from "./agent-directory-provider.js";
import { TeammateAvatar } from "./teammate-avatar.js";
import { useArrangedAgents } from "../hook/use-arranged-agents.js";
import { moveTeammate } from "../model/teammate-order.js";

/** A drag starts only after the pointer moves, so clicking a handle never reorders. */
const pointerActivation = { distance: 5 };

/** Teammates move only up and down the list. */
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/**
 * Target the nearest teammate, except when a pointer is outside the sidebar, where dropping
 * cancels the move. Keyboard moves have no pointer and always target the nearest teammate.
 */
function nearestInside(list: {
  current: HTMLElement | null;
}): CollisionDetection {
  return (args) => {
    const pointer = args.pointerCoordinates;
    const area = list.current?.closest("aside") ?? list.current;
    const bounds = area?.getBoundingClientRect();
    const outside =
      pointer &&
      bounds &&
      (pointer.x < bounds.left ||
        pointer.x > bounds.right ||
        pointer.y < bounds.top ||
        pointer.y > bounds.bottom);
    return outside ? [] : closestCenter(args);
  };
}

/** Read to screen reader users when a reorder handle is focused. */
const screenReaderInstructions = {
  draggable:
    "Press Space or Enter to pick up this teammate. Use the up and down arrow keys to move them, then press Space or Enter to drop them. Press Escape to cancel.",
};

/** List teammates in the owner's order; drag a handle, or use its keyboard controls, to rearrange them. */
export function TeammateNavigation() {
  const agents = useAgents();
  const unread = useUpdateCount().data?.byAgent;
  const { teammates, orderLoaded, orderFailed, retryOrder } = useArrangedAgents(
    agents.data,
  );
  const save = useSaveTeammateOrder();
  const list = useRef<HTMLDivElement>(null);
  // Announce a move only when the target changes, so picking up isn't talked over.
  const announcedOver = useRef<UniqueIdentifier | null>(null);
  const [sorting, setSorting] = useState(false);
  const [outside, setOutside] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: pointerActivation }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const ids = teammates?.map((teammate) => teammate.id) ?? [];
  // Keep the saved order safe when it couldn't load, and skip handles that could move nothing.
  const reorderable = orderLoaded && ids.length > 1;
  const nameOf = (id: UniqueIdentifier) =>
    teammates?.find((teammate) => teammate.id === id)?.name ?? "Teammate";
  const positionOf = (id: UniqueIdentifier) =>
    `position ${ids.indexOf(String(id)) + 1} of ${ids.length}`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      announcedOver.current = active.id;
      return `Picked up ${nameOf(active.id)} in ${positionOf(active.id)}.`;
    },
    onDragOver: ({ active, over }) => {
      const target = over?.id ?? null;
      if (target === announcedOver.current) return undefined;
      announcedOver.current = target;
      return target === null
        ? `${nameOf(active.id)} is outside the sidebar. Dropping here keeps the current order.`
        : `${nameOf(active.id)} moved to ${positionOf(target)}.`;
    },
    onDragEnd: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} dropped in ${positionOf(over.id)}.`
        : `${nameOf(active.id)} dropped outside the sidebar. The order didn’t change.`,
    onDragCancel: ({ active }) =>
      `Reordering cancelled. ${nameOf(active.id)} is back in ${positionOf(active.id)}.`,
  };
  return (
    <div
      ref={list}
      className={`sidebar-agents${sorting ? " sorting" : ""}${outside ? " outside" : ""}`}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={nearestInside(list)}
        modifiers={[verticalOnly]}
        accessibility={{ announcements, screenReaderInstructions }}
        onDragStart={() => setSorting(true)}
        onDragOver={({ over }) => setOutside(!over)}
        onDragCancel={() => {
          setSorting(false);
          setOutside(false);
        }}
        onDragEnd={({ active, over }) => {
          setSorting(false);
          setOutside(false);
          const next =
            over && moveTeammate(ids, String(active.id), String(over.id));
          if (next) save.mutate({ teammateIds: next });
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {teammates?.map((agent) => (
            <SortableTeammate
              key={agent.id}
              agent={agent}
              unread={unread?.[agent.id] ?? 0}
              reorderable={reorderable}
            />
          ))}
        </SortableContext>
      </DndContext>
      {orderFailed && (
        <div className="sidebar-error" role="alert">
          <p>
            Your teammate order couldn’t load, so teammates are shown in the
            order you created them.
          </p>
          <button type="button" onClick={retryOrder}>
            Try again
          </button>
        </div>
      )}
      {save.isError && (
        <p className="sidebar-error" role="alert">
          Couldn’t save your teammate order. Try again.
        </p>
      )}
      {agents.data?.length === 0 && (
        <p className="sidebar-empty">No teammates yet.</p>
      )}
      {agents.isError && (
        <p className="sidebar-empty">
          Your team couldn’t load. <NavLink to="/team">Try again</NavLink>
        </p>
      )}
    </div>
  );
}

/** One teammate link; the handle beside it is the only place a drag can start. */
function SortableTeammate({
  agent,
  unread,
  reorderable,
}: {
  agent: Agent;
  unread: number;
  reorderable: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: agent.id, disabled: !reorderable });
  return (
    <div
      ref={setNodeRef}
      className={`side-agent-row${reorderable ? " reorderable" : ""}${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <NavLink
        className={({ isActive }) => `side-agent ${isActive ? "active" : ""}`}
        to={`/team/${encodeURIComponent(agent.id)}`}
        aria-label={unreadLinkLabel(agent.name, unread)}
      >
        <TeammateAvatar avatarId={agent.avatarId} small />
        <span className="side-agent-name">{agent.name}</span>
        <UpdateCountBadge count={unread} />
      </NavLink>
      {reorderable && (
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="side-agent-handle"
          title="Drag to reorder"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${agent.name}`}
          aria-roledescription={undefined}
        >
          <GripVertical aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
