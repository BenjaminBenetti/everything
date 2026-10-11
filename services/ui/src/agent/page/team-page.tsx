import { useState } from "react";
import { Pencil, Plus, Search } from "lucide-react";
import { Button } from "@everything/ui/button";
import { useAgents } from "../component/agent-directory-provider.js";
import { AgentCard } from "../component/agent-card.js";
import { PageHeading } from "../../workspace/component/page-heading.js";
import { useWorkspaceDialogs } from "../../workspace/component/workspace-dialogs.js";

/** Search and manage durable agent definitions through the shared directory query. */
export function TeamPage() {
  const [search, setSearch] = useState("");
  const agents = useAgents();
  const { open } = useWorkspaceDialogs();
  const term = search.trim().toLocaleLowerCase();
  const filtered =
    agents.data?.filter((agent) =>
      `${agent.name} ${agent.systemPrompt}`.toLocaleLowerCase().includes(term),
    ) ?? [];
  return (
    <div className="content-inner">
      <PageHeading
        title="Your team."
        description="One place for whatever’s on your mind."
        action={
          <Button onClick={() => open({ kind: "editor" })}>
            <Plus aria-hidden="true" />
            New agent
          </Button>
        }
      />
      <div className="list-tools">
        <h2 className="section-label">
          Your team <span>{agents.data?.length ?? "—"}</span>
        </h2>
        <label className="search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search agents</span>
          <input
            type="search"
            placeholder="Find an agent…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      {agents.isPending && (
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
      {!agents.isPending && !agents.isError && (
        <div className="agent-grid">
          {filtered.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
          {!term && (
            <button
              className="new-card"
              onClick={() => open({ kind: "editor" })}
            >
              <Plus aria-hidden="true" />
              <span>
                <strong>Make room for someone new</strong>
                <small>Create and name an agent</small>
              </span>
            </button>
          )}
          {term && filtered.length === 0 && (
            <p className="empty-search" role="status">
              No matching agents. Try another name.
            </p>
          )}
        </div>
      )}
      <p className="workspace-note">
        <Pencil aria-hidden="true" />
        These are your agents. Give them names that feel like yours.
      </p>
    </div>
  );
}
