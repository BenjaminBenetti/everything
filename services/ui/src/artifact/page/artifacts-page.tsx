import { useState } from "react";
import { FolderOpen, Search } from "lucide-react";
import { Button } from "@everything/ui/button";
import { SearchInput } from "@everything/ui/search-input";
import { PageHeading } from "../../workspace/component/page-heading.js";
import { EmptyState } from "../../workspace/component/empty-state.js";
import { ArtifactCard } from "../component/artifact-card.js";
import { useArtifacts } from "../component/artifact-library-provider.js";
import { visibleApps } from "../model/artifact-presentation.js";

/** Browse the pages and apps every teammate shares. */
export function ArtifactsPage() {
  const [search, setSearch] = useState("");
  const artifacts = useArtifacts();
  const apps = visibleApps(artifacts.data ?? [], search);
  return (
    <div className="content-inner">
      <PageHeading title="Apps" description="Apps shared by your teammates." />
      <div className="list-tools artifact-list-tools">
        <SearchInput
          label="Search apps"
          placeholder="Search apps…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
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
          <p>Try another name or description.</p>
          <Button variant="light" onClick={() => setSearch("")}>
            Clear search
          </Button>
        </div>
      )}
      {!!artifacts.data?.length && (
        <div className="artifact-grid">
          {apps.map((artifact) => (
            <ArtifactCard
              key={artifact.id}
              artifact={artifact}
              unavailable={artifacts.isError}
            />
          ))}
        </div>
      )}
    </div>
  );
}
