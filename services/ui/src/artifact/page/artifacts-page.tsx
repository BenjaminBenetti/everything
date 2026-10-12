import { FolderOpen } from "lucide-react";
import { Button } from "@everything/ui/button";
import { PageHeading } from "../../workspace/component/page-heading.js";
import { EmptyState } from "../../workspace/component/empty-state.js";
import { ArtifactCard } from "../component/artifact-card.js";
import { useArtifacts } from "../component/artifact-library-provider.js";

/** Browse the pages and apps every teammate shares. */
export function ArtifactsPage() {
  const artifacts = useArtifacts();
  return (
    <div className="content-inner">
      <PageHeading
        title="Artifacts"
        description="Pages and apps shared by your teammates."
      />
      {artifacts.isPending && (
        <p className="status-panel" role="status">
          Loading artifacts…
        </p>
      )}
      {artifacts.isError && (
        <div className="status-panel" role="alert">
          <p>{artifacts.error.message}</p>
          <Button variant="light" onClick={() => void artifacts.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {artifacts.data?.length === 0 && (
        <div className="updates-feed">
          <EmptyState icon={FolderOpen} title="No artifacts yet">
            <p>
              Ask a teammate to build a page or an app. It will appear here for
              you and every teammate.
            </p>
          </EmptyState>
        </div>
      )}
      {!!artifacts.data?.length && (
        <div className="artifact-grid">
          {artifacts.data.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </div>
      )}
    </div>
  );
}
