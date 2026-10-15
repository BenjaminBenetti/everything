import { useState } from "react";
import { Boxes, Layers3, Search } from "lucide-react";
import { Button } from "@everything/ui/button";
import { SearchInput } from "@everything/ui/search-input";
import { PageHeading } from "../component/page-heading.js";
import { EmptyState } from "../component/empty-state.js";
import { useWorkspaces } from "../component/workspace-directory-provider.js";
import { WorkspaceInstanceCard } from "../component/workspace-instance-card.js";
import { groupWorkspaces } from "../model/workspace-presentation.js";

/** Browse shared workspace instances by type and search their names. */
export function WorkspacesPage() {
  const [search, setSearch] = useState("");
  const workspaces = useWorkspaces();
  const groups = groupWorkspaces(workspaces.data ?? [], search);
  const count = groups.reduce((sum, [, items]) => sum + items.length, 0);
  return (
    <div className="content-inner workspaces-page">
      <PageHeading
        title="Workspaces"
        description="Manage the workspaces your teammates use, grouped by type."
      />
      <div className="list-tools workspace-list-tools">
        <SearchInput
          label="Search workspaces"
          placeholder="Search by name or type…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {workspaces.data && (
          <p className="workspace-result-count" role="status">
            {count} {count === 1 ? "workspace" : "workspaces"}
          </p>
        )}
      </div>
      {workspaces.isPending && (
        <p className="status-panel" role="status">
          Loading workspaces…
        </p>
      )}
      {workspaces.isError && (
        <div className="status-panel" role="alert">
          <p>
            {workspaces.data
              ? "Workspace status couldn’t refresh. Controls will be available when the connection returns."
              : "Workspaces couldn’t load. Try again in a moment."}
          </p>
          <Button variant="light" onClick={() => void workspaces.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {!workspaces.isError && workspaces.data?.length === 0 && (
        <div className="updates-feed">
          <EmptyState icon={Boxes} title="No workspaces yet">
            <p>
              Ask a teammate to create a workspace. It will appear here when
              it’s ready.
            </p>
          </EmptyState>
        </div>
      )}
      {!!workspaces.data?.length && count === 0 && (
        <div className="workspace-empty-search" role="status">
          <Search aria-hidden="true" />
          <h2>No matching workspaces</h2>
          <p>Try another instance name or type.</p>
          <Button variant="light" onClick={() => setSearch("")}>
            Clear search
          </Button>
        </div>
      )}
      {groups.map(([type, items]) => (
        <section
          className="workspace-type-group"
          key={type}
          aria-label={`${type} workspaces`}
        >
          <div className="workspace-type-heading">
            <Layers3 aria-hidden="true" />
            <h2>{type}</h2>
            <span>{items.length}</span>
          </div>
          <div className="workspace-instance-grid">
            {items.map((workspace) => (
              <WorkspaceInstanceCard
                key={workspace.name}
                workspace={workspace}
                unavailable={workspaces.isError}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
