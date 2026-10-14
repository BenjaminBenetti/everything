import { Check, MessageSquare } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@everything/ui/button";
import { useAgents } from "../../agent/component/agent-directory-provider.js";
import { TeammateAvatar } from "../../agent/component/teammate-avatar.js";
import { EmptyState } from "../../workspace/component/empty-state.js";
import { useUpdates } from "../hook/use-updates.js";

/** Present unread previews without marking the underlying message read on a feed fetch or click. */
export function UpdateFeed({ limit }: { limit?: number }) {
  const feed = useUpdates();
  const agents = useAgents();
  const updates = [
    ...new Map(
      feed.data?.pages
        .flatMap((page) => page.updates)
        .map((update) => [update.messageId, update]),
    ).values(),
  ].slice(0, limit);
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
      {!feed.isPending && !feed.isError && !updates.length && (
        <EmptyState icon={Check} title="You’re all caught up">
          <p>Messages you haven’t seen from your teammates will appear here.</p>
          <Link className="text-link" to="/team">
            View your team →
          </Link>
        </EmptyState>
      )}
      {updates.length > 0 && (
        <ul className="update-list" aria-label="Unread teammate messages">
          {updates.map((update) => {
            const agent = agents.data?.find(
              (item) => item.id === update.agentId,
            );
            return (
              <li key={update.messageId}>
                <Link
                  className="update-row"
                  to={`/team/${encodeURIComponent(update.agentId)}?message=${encodeURIComponent(update.messageId)}`}
                >
                  <TeammateAvatar
                    avatarId={agent?.avatarId ?? "avatar-01"}
                    small
                  />
                  <div className="update-copy">
                    <div className="update-meta">
                      <strong>{agent?.name ?? "Teammate"}</strong>
                      <time dateTime={update.createdAt}>
                        {new Date(update.createdAt).toLocaleString([], {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                    <span className="update-summary-kind">
                      {update.summaryStatus === "ready"
                        ? "AI summary"
                        : update.summaryStatus === "pending"
                          ? "Preparing summary · Message preview"
                          : "Summary unavailable · Message preview"}
                    </span>
                    <p>{update.summary}</p>
                  </div>
                  <MessageSquare className="update-icon" aria-hidden="true" />
                  <span className="sr-only">Unread. Open message.</span>
                </Link>
              </li>
            );
          })}
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
