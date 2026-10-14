import { ArrowRight, Smartphone } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeading } from "../../workspace/component/page-heading.js";
import { UpdateFeed } from "../../update/component/update-feed.js";
import { useWorkspaceDialogs } from "../../workspace/component/workspace-dialogs.js";

/** Show recent unread updates and entry points into the team. */
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
          <UpdateFeed limit={8} />
        </section>
        <aside className="dashboard-recent" aria-labelledby="recent-heading">
          <div className="section-heading">
            <h2 id="recent-heading">Your conversations</h2>
          </div>
          <p className="recent-intro">Pick up where you left off.</p>
          <p className="recent-empty">
            Open a teammate to return to your conversation. Your messages stay
            together in one place.
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
