import { Check } from "lucide-react";
import { Link } from "react-router-dom";
import type { Update } from "@everything/update-contracts";
import { Button } from "@everything/ui/button";
import { useAgents } from "../../agent/component/agent-directory-provider.js";
import { TeammateAvatar } from "../../agent/component/teammate-avatar.js";
import { EmptyState } from "../../workspace/component/empty-state.js";
import { useUpdates } from "../hook/use-updates.js";
import {
  presentUpdate,
  summaryLabels,
  type UpdatePresentation,
} from "../model/update-presentation.js";

/** Present unread updates without marking their sources read on a feed fetch or click. */
export function UpdateFeed({ limit }: { limit?: number }) {
  const feed = useUpdates();
  const agents = useAgents();
  const rows = [
    ...new Map(
      feed.data?.pages
        .flatMap((page) => page.updates)
        .map((update) => [update.id, update]),
    ).values(),
  ]
    .flatMap((update) => {
      const presentation = presentUpdate(update, agents.data);
      return presentation ? [{ update, presentation }] : [];
    })
    .slice(0, limit);
  return (
    <div className="updates-feed">
      {feed.isPending && (
        <p className="status-panel" role="status">
          Loading updates…
        </p>
      )}
      {feed.isError && (
        <div className="status-panel" role="alert">
          <p>{feed.error.message}</p>
          <Button variant="light" onClick={() => void feed.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {!feed.isPending && !feed.isError && !rows.length && (
        <EmptyState icon={Check} title="You’re all caught up">
          <p>Messages you haven’t seen from your teammates will appear here.</p>
          <Link className="text-link" to="/team">
            View your team →
          </Link>
        </EmptyState>
      )}
      {rows.length > 0 && (
        <ul className="update-list" aria-label="Unread updates">
          {rows.map(({ update, presentation }) => (
            <li key={update.id}>
              <UpdateRow update={update} presentation={presentation} />
            </li>
          ))}
        </ul>
      )}
      {!limit && feed.hasNextPage && (
        <div className="update-more">
          <Button
            variant="light"
            disabled={feed.isFetchingNextPage}
            onClick={() => void feed.fetchNextPage()}
          >
            {feed.isFetchingNextPage ? "Loading updates…" : "Load more updates"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** One update, with its summary as the main line under where it came from and when. */
function UpdateRow({
  update,
  presentation: { to, source, avatarId, icon: Icon, action },
}: {
  update: Update;
  presentation: UpdatePresentation;
}) {
  const label = summaryLabels[update.summaryStatus];
  return (
    <Link className="update-row" to={to}>
      {avatarId ? (
        <TeammateAvatar avatarId={avatarId} small />
      ) : (
        <span className="update-kind-icon" aria-hidden="true">
          <Icon />
        </span>
      )}
      <div className="update-copy">
        <div className="update-meta">
          <span className="update-source">{source}</span>
          {label && <span className="update-label">{label}</span>}
          <time dateTime={update.createdAt}>
            {new Date(update.createdAt).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
        <p className="update-summary">{update.summary}</p>
      </div>
      <Icon className="update-icon" aria-hidden="true" />
      <span className="sr-only">Unread. {action}.</span>
    </Link>
  );
}
