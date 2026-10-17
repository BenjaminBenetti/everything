import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@everything/ui/button";
import { SearchInput } from "@everything/ui/search-input";
import { useAgents } from "../component/agent-directory-provider.js";
import { useArrangedAgents } from "../hook/use-arranged-agents.js";
import { AgentCard } from "../component/agent-card.js";
import { PageHeading } from "../../workspace/component/page-heading.js";
import { useWorkspaceDialogs } from "../../workspace/component/workspace-dialogs.js";
import { useUpdateCount } from "../../update/hook/use-updates.js";

/** Search and manage teammates in the owner's order, with unread totals from the shared count query. */
export function TeamPage() {
  const [search, setSearch] = useState("");
  const agents = useAgents();
  const { teammates } = useArrangedAgents(agents.data);
  const updateCounts = useUpdateCount().data;
  const { open } = useWorkspaceDialogs();
  const term = search.trim().toLocaleLowerCase();
  const loading = agents.isPending || (agents.isSuccess && !teammates);
  const filtered =
    teammates?.filter((agent) =>
      `${agent.name} ${agent.systemPrompt}`.toLocaleLowerCase().includes(term),
    ) ?? [];
  return (
    <div className="content-inner">
      <PageHeading
        title="Your team"
        description="Manage your teammates and their profiles."
        action={
          <Button onClick={() => open({ kind: "editor" })}>
            <Plus aria-hidden="true" />
            New teammate
          </Button>
        }
      />
      <div className="list-tools">
        <h2 className="section-label">
          Your team <span>{agents.data?.length ?? "—"}</span>
        </h2>
        <SearchInput
          className="team-search"
          label="Search teammates"
          placeholder="Find a teammate…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {loading && (
        <p className="status-panel" role="status">
          Loading your team…
        </p>
      )}
      {agents.isError && (
        <div className="status-panel" role="alert">
          <p>{agents.error.message}</p>
          <Button variant="light" onClick={() => void agents.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {!loading && !agents.isError && (
        <div className="agent-grid">
          {filtered.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              unreadCount={updateCounts?.byAgent?.[agent.id] ?? 0}
            />
          ))}
          {!term && (
            <button
              className="new-card"
              onClick={() => open({ kind: "editor" })}
            >
              <Plus aria-hidden="true" />
              <span>
                <strong>Create a new teammate</strong>
                <small>Choose a name, description, and avatar</small>
              </span>
            </button>
          )}
          {term && filtered.length === 0 && (
            <p className="empty-search" role="status">
              No matching teammates. Try another name.
            </p>
          )}
        </div>
      )}
      <p className="workspace-note">
        <Pencil aria-hidden="true" />
        You can edit a teammate’s name, description, and avatar at any time.
      </p>
    </div>
  );
}
