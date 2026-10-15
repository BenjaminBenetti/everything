import { PageHeading } from "../../workspace/component/page-heading.js";
import { UpdateFeed } from "../component/update-feed.js";

/** Keep unread updates first, followed by seen messages that remain accessible in chat. */
export function UpdatesPage() {
  return (
    <div className="content-inner">
      <PageHeading
        title="Updates"
        description="Catch up on messages you haven’t seen from your teammates."
      />
      <UpdateFeed />
      <section
        className="updates-history"
        aria-labelledby="updates-history-heading"
      >
        <h2 id="updates-history-heading">Seen</h2>
        <UpdateFeed seen />
      </section>
    </div>
  );
}
