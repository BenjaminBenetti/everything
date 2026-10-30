import { Link, useParams, useSearchParams } from "react-router-dom";
import type { Agent } from "@everything/agent-contracts";
import { Button } from "@everything/ui/button";
import { useAgents } from "../../agent/component/agent-directory-provider.js";
import { useWorkspaceDialogs } from "../../workspace/component/workspace-dialogs.js";
import { useConversation } from "../hook/use-conversation.js";
import { MessageComposer } from "../component/message-composer.js";
import { MessageHistory } from "../component/message-history.js";
import { ConversationDetails } from "../component/conversation-details.js";
import { CompactionIndicator } from "../component/compaction-indicator.js";
import { useReplyNotifications } from "../../notification/hook/use-reply-notifications.js";
import { mainTeammateActivity } from "../model/main-activity.js";

/** Resolve the teammate's sole conversation from the directory, including direct links. */
export function ConversationPage() {
  const { agentId } = useParams();
  const agents = useAgents();
  const agent = agents.data?.find((item) => item.id === agentId);
  if (agents.isPending)
    return (
      <p className="status-panel" role="status">
        Loading your teammate…
      </p>
    );
  if (agents.isError)
    return (
      <div className="status-panel" role="alert">
        <p>{agents.error.message}</p>
        <Button onClick={() => void agents.refetch()}>Try again</Button>
      </div>
    );
  if (!agent)
    return (
      <div className="status-panel">
        <h1>Teammate unavailable</h1>
        <p>This teammate may have been deleted.</p>
        <Link className="text-link" to="/team">
          Return to your team
        </Link>
      </div>
    );
  return <TeammateConversation key={agent.id} agent={agent} />;
}

/** Present the ongoing conversation with visible compaction progress, main activity, and background activity. */
function TeammateConversation({ agent }: { agent: Agent }) {
  const { open } = useWorkspaceDialogs();
  const [search] = useSearchParams();
  const targetMessageId = search.get("message") || undefined;
  const { history, snapshot, send, older, targetFound, retryTarget } =
    useConversation(agent.id, targetMessageId);
  useReplyNotifications(
    agent,
    snapshot.data?.page.messages,
    snapshot.dataUpdatedAt,
  );
  const runtime = snapshot.data?.runtime;
  // The typing indicator tracks only messages; background activity appears in the teammate card.
  const typing = runtime?.status === "running" && runtime.typing;
  // The avatar follows the main session and its monitors, never background teammates or a stale snapshot.
  const activity = mainTeammateActivity(snapshot);
  const error =
    send.error?.message ??
    older.error?.message ??
    snapshot.error?.message ??
    runtime?.error;
  return (
    <section className="chat-page" aria-label={`Chat with ${agent.name}`}>
      <ConversationDetails
        agent={agent}
        activity={activity}
        backgroundCount={runtime?.backgroundCount ?? 0}
        onEdit={() => open({ kind: "editor", agent })}
      />
      {snapshot.isPending ? (
        <p className="chat-loading" role="status">
          Loading your messages…
        </p>
      ) : (
        <MessageHistory
          agentId={agent.id}
          name={agent.name}
          targetMessageId={targetMessageId}
          readEnabled={!targetMessageId || targetFound}
          messages={history?.messages ?? []}
          latestMessages={snapshot.data?.page.messages}
          hasOlder={!!history?.nextCursor}
          loadingOlder={older.isPending}
          sentMessageId={send.data?.messageId}
          typing={typing}
          onOlder={() => older.mutateAsync(history!.nextCursor!)}
        />
      )}
      <div className="chat-footer">
        {runtime?.status === "running" && runtime.compacting && (
          <CompactionIndicator
            key={runtime.compactionStartedAt}
            startedAt={runtime.compactionStartedAt ?? null}
          />
        )}
        {targetMessageId && !targetFound && !!history && !snapshot.isError && (
          <div className="chat-setup" role="status">
            <p>
              {older.isError
                ? "The message couldn’t load."
                : history?.nextCursor
                  ? "Finding the original message…"
                  : "This message is no longer available."}
            </p>
            {older.isError && (
              <Button variant="light" onClick={retryTarget}>
                Try again
              </Button>
            )}
            <Link
              className="text-link"
              to={`/team/${encodeURIComponent(agent.id)}`}
            >
              Return to latest messages
            </Link>
          </div>
        )}
        {error && (
          <div className="chat-error" role="alert">
            <p>{error}</p>
            {snapshot.isError && (
              <Button variant="light" onClick={() => void snapshot.refetch()}>
                Reconnect
              </Button>
            )}
            <button
              className="text-link"
              onClick={() => open({ kind: "provider" })}
            >
              Model providers
            </button>
          </div>
        )}
        {!agent.inference && (
          <div className="chat-setup">
            <p>
              Choose this teammate’s provider, model, and effort level to send
              messages.
            </p>
            <Button
              variant="light"
              onClick={() => open({ kind: "editor", agent })}
            >
              Choose a model
            </Button>
          </div>
        )}
        <MessageComposer
          agentId={agent.id}
          name={agent.name}
          disabled={!agent.inference || snapshot.isPending || snapshot.isError}
          sending={send.isPending}
          onSend={(input) => send.mutateAsync(input)}
        />
      </div>
    </section>
  );
}
