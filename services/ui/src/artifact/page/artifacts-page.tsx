import { useState } from "react";
import { FolderOpen, Search, X } from "lucide-react";
import { Button, IconButton } from "@everything/ui/button";
import { SearchInput } from "@everything/ui/search-input";
import { PageHeading } from "../../workspace/component/page-heading.js";
import { EmptyState } from "../../workspace/component/empty-state.js";
import { ArtifactCard } from "../component/artifact-card.js";
import { useArtifacts } from "../component/artifact-library-provider.js";
import { visibleApps } from "../model/artifact-presentation.js";
import { useAgents } from "../../agent/component/agent-directory-provider.js";
import {
  allApps,
  appCreators,
  type AppFilters,
} from "../model/artifact-filters.js";
import { ArtifactFilters } from "../component/artifact-filters.js";

/** Browse the pages and apps every teammate shares. */
export function ArtifactsPage() {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<AppFilters>(allApps);
  const artifacts = useArtifacts();
  const agents = useAgents();
  const creators = appCreators(artifacts.data ?? [], agents.data);
  const creatorsById = new Map(
    creators.map((creator) => [creator.id, creator]),
  );
  const apps = visibleApps(artifacts.data ?? [], search, filters);
  const hasFilters = !!(
    filters.creatorId ||
    filters.kind ||
    filters.database ||
    filters.api
  );

  /** Restore the full library, including clearing any search term. */
  function clearFilters(): void {
    setSearch("");
    setFilters(allApps);
  }
  return (
    <div className="content-inner">
      <PageHeading title="Apps" description="Apps shared by your teammates." />
      <div className="artifact-list-tools">
        <SearchInput
          label="Search apps"
          placeholder="Search apps…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <ArtifactFilters
          value={filters}
          creators={creators}
          onChange={setFilters}
        />
        {hasFilters && (
          <IconButton label="Clear filters" onClick={clearFilters}>
            <X aria-hidden="true" />
          </IconButton>
        )}
        {artifacts.data && (
          <p className="artifact-result-count" role="status">
            {apps.length} {apps.length === 1 ? "app" : "apps"}
          </p>
        )}
      </div>
      {artifacts.isPending && (
        <p className="status-panel" role="status">
          Loading apps…
        </p>
      )}
      {artifacts.isError && (
        <div className="status-panel" role="alert">
          <p>
            {artifacts.data
              ? "App status couldn’t refresh. Controls will be available when the connection returns."
              : artifacts.error.message}
          </p>
          <Button variant="light" onClick={() => void artifacts.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {!artifacts.isError && artifacts.data?.length === 0 && (
        <div className="updates-feed">
          <EmptyState icon={FolderOpen} title="No apps yet">
            <p>
              Ask a teammate to build an app. It will appear here for you and
              every teammate.
            </p>
          </EmptyState>
        </div>
      )}
      {!!artifacts.data?.length && apps.length === 0 && (
        <div className="artifact-empty-search" role="status">
          <Search aria-hidden="true" />
          <h2>No matching apps</h2>
          <p>Try another search or change your filters.</p>
          <Button variant="light" onClick={clearFilters}>
            Reset search and filters
          </Button>
        </div>
      )}
      {!!artifacts.data?.length && (
        <div className="artifact-grid">
          {apps.map((artifact) => (
            <ArtifactCard
              key={artifact.id}
              artifact={artifact}
              creator={
                creatorsById.get(artifact.createdBy.id) ?? artifact.createdBy
              }
              unavailable={artifacts.isError}
            />
          ))}
        </div>
      )}
    </div>
  );
}
