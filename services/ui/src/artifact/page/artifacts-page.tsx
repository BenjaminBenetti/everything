import { FolderOpen } from "lucide-react";
import { PageHeading } from "../../workspace/component/page-heading.js";
import { EmptyState } from "../../workspace/component/empty-state.js";

/** Present the artifact library without assuming an artifact service exists. */
export function ArtifactsPage() {
  return (
    <div className="content-inner">
      <PageHeading
        title="Made together."
        description="A home for the things your agents share with you."
      />
      <div className="updates-feed">
        <EmptyState icon={FolderOpen} title="Room for your next idea.">
          <p>
            Pages, research, and other shared work will live here. There are no
            artifacts yet.
          </p>
        </EmptyState>
      </div>
    </div>
  );
}
