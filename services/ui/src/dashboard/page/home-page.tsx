import { ArrowRight, Check, Smartphone } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeading } from "../../workspace/component/page-heading.js";
import { EmptyState } from "../../workspace/component/empty-state.js";
import { useWorkspaceDialogs } from "../../workspace/component/workspace-dialogs.js";

/** Home retains the concept's inbox and recent-conversation layout without starting chat. */
export function HomePage() {
  const { open } = useWorkspaceDialogs();
  return (
    <div className="content-inner dashboard-inner">
      <PageHeading
        eyebrow="Overview"
        title="Welcome back."
        description="Manage your team and view updates."
      />
      <div className="dashboard-grid">
        <section aria-labelledby="updates-heading">
          <div className="section-heading">
            <h2 id="updates-heading">Updates for you</h2>
            <Link className="text-link" to="/updates">
              View all <ArrowRight aria-hidden="true" />
            </Link>
          </div>
          <div className="updates-feed">
            <EmptyState icon={Check} title="No updates yet">
              <p>Updates will appear here when conversations are available.</p>
              <Link className="text-link" to="/team">
                View your team <ArrowRight aria-hidden="true" />
              </Link>
            </EmptyState>
          </div>
        </section>
        <aside className="dashboard-recent" aria-labelledby="recent-heading">
          <div className="section-heading">
            <h2 id="recent-heading">Recent conversations</h2>
          </div>
          <p className="recent-intro">No conversations yet.</p>
          <p className="recent-empty">
            Conversations aren’t available yet. You can create and edit
            teammates now.
          </p>
          <Link className="team-link" to="/team">
            View your team <ArrowRight aria-hidden="true" />
          </Link>
          <div className="dashboard-phone">
            <Smartphone aria-hidden="true" />
            <div>
              <strong>Use Everything on your phone</strong>
              <p>Add Everything to your Home Screen.</p>
              <button
                className="text-link"
                onClick={() => open({ kind: "notifications" })}
              >
                Phone setup <ArrowRight aria-hidden="true" />
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
