import { useEffect, useRef } from "react";
import { Button } from "@everything/ui/button";

/** Load another page near the end of the feed, with an explicit retry and keyboard fallback. */
export function UpdatePagination({
  fetching,
  error,
  loadMore,
}: {
  fetching: boolean;
  error: Error | null;
  loadMore: () => Promise<unknown>;
}) {
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (fetching || error || !sentinel.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void loadMore().catch(() => undefined);
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [fetching, error, loadMore]);

  return (
    <div className="update-more" ref={sentinel}>
      {error && <p role="alert">Couldn’t load older updates. Try again.</p>}
      <Button
        variant="light"
        disabled={fetching}
        onClick={() => void loadMore().catch(() => undefined)}
      >
        {fetching
          ? "Loading updates…"
          : error
            ? "Try again"
            : "Load more updates"}
      </Button>
    </div>
  );
}
