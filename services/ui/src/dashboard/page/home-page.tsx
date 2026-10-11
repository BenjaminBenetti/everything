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
        eyebrow="Your space, at a glance"
        title="Welcome back."
        description="A little space for you and everything you’ll do."
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
            <EmptyState icon={Check} title="You’re all caught up.">
              <p>New messages and shared work will appear here.</p>
              <Link className="text-link" to="/team">
                Visit your team <ArrowRight aria-hidden="true" />
              </Link>
            </EmptyState>
          </div>
        </section>
        <aside className="dashboard-recent" aria-labelledby="recent-heading">
          <div className="section-heading">
            <h2 id="recent-heading">Recent conversations</h2>
          </div>
          <p className="recent-intro">Pick up where you left off.</p>
          <p className="recent-empty">
            Conversations will be available in a future update. Your team is
            ready to take shape.
          </p>
          <Link className="team-link" to="/team">
            See your whole team <ArrowRight aria-hidden="true" />
          </Link>
          <div className="dashboard-phone">
            <Smartphone aria-hidden="true" />
            <div>
              <strong>Take Everything with you.</strong>
              <p>Make a little room on your Home Screen.</p>
              <button
                className="text-link"
                onClick={() => open({ kind: "notifications" })}
              >
                Set up your phone <ArrowRight aria-hidden="true" />
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
