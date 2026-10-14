import { PageHeading } from "../../workspace/component/page-heading.js";
import { UpdateFeed } from "../component/update-feed.js";

/** Show unread teammate messages and link back to their exact place in the conversation. */
export function UpdatesPage() {
  return (
    <div className="content-inner">
      <PageHeading
        title="Updates"
        description="Catch up on messages you haven’t seen from your teammates."
      />
      <UpdateFeed />
    </div>
  );
}
