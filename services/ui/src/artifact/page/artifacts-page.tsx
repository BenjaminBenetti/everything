import { FolderOpen } from "lucide-react";
import { PageHeading } from "../../workspace/component/page-heading.js";
import { EmptyState } from "../../workspace/component/empty-state.js";

/** Present the artifact library without assuming an artifact service exists. */
export function ArtifactsPage() {
  return (
    <div className="content-inner">
      <PageHeading
        title="Artifacts"
        description="Files and pages shared by your teammates."
      />
      <div className="updates-feed">
        <EmptyState icon={FolderOpen} title="No artifacts yet">
          <p>Shared work will appear here in a future update.</p>
        </EmptyState>
      </div>
    </div>
  );
}
