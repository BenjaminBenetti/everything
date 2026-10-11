import { Check } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeading } from "../../workspace/component/page-heading.js";
import { EmptyState } from "../../workspace/component/empty-state.js";

/** Reserve the update feed surface while messaging is outside this release. */
export function UpdatesPage() {
  return (
    <div className="content-inner">
      <PageHeading
        title="Your updates."
        description="Messages and shared work from your team."
      />
      <div className="updates-feed">
        <EmptyState icon={Check} title="You’re all caught up.">
          <p>
            There’s nothing to review yet. Updates will arrive here when
            conversations are available.
          </p>
          <Link className="text-link" to="/team">
            Visit your team →
          </Link>
        </EmptyState>
      </div>
    </div>
  );
}
