import { useEffect, useState } from "react";
import { Minimize2 } from "lucide-react";

/** Explain the pause in replies with a live timer anchored to the server's compaction start. */
export function CompactionIndicator({
  startedAt,
}: {
  startedAt: string | null;
}) {
  const [observedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  const start = startedAt ? Date.parse(startedAt) : observedAt;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="chat-compaction">
      <div className="chat-compaction-status" role="status">
        <Minimize2 aria-hidden="true" />
        <div>
          <strong>Compacting</strong>
          <p>Summarizing this conversation before replying.</p>
        </div>
      </div>
      <span role="timer" aria-label="Time spent compacting" aria-live="off">
        {elapsed}
      </span>
    </div>
  );
}
