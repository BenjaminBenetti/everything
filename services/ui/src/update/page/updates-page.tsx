import { Check } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeading } from "../../workspace/component/page-heading.js";
import { EmptyState } from "../../workspace/component/empty-state.js";

/** Reserve the update feed surface while messaging is outside this release. */
export function UpdatesPage() {
  return (
    <div className="content-inner">
      <PageHeading
        title="Updates"
        description="Messages and shared work from your teammates."
      />
      <div className="updates-feed">
        <EmptyState icon={Check} title="No updates yet">
          <p>Updates will appear here when messaging is available.</p>
          <Link className="text-link" to="/team">
            View your team →
          </Link>
        </EmptyState>
      </div>
    </div>
  );
}
