import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Brand } from "@everything/ui/brand";
import { Button } from "@everything/ui/button";
import { useArtifactLibrary } from "../component/artifact-library-provider.js";

/** Sign the browser in to the app host, then continue to the requested app. */
export function ArtifactOpenPage() {
  const library = useArtifactLibrary();
  const [parameters] = useSearchParams();
  const [failure, setFailure] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const slug = parameters.get("slug") ?? "";
  const path = parameters.get("path") ?? undefined;

  useEffect(() => {
    let cancelled = false;
    setFailure(undefined);
    library
      .open(slug, path)
      .then((url) => {
        if (!cancelled) location.replace(url);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure((error as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [library, slug, path, attempt]);

  return (
    <main className="startup-screen">
      <Brand />
      {failure ? (
        <>
          <p role="alert">{failure}</p>
          <Button onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </Button>
        </>
      ) : (
        <p role="status">Opening the app…</p>
      )}
    </main>
  );
}
