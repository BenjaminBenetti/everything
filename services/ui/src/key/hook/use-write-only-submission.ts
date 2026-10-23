import { useEffect, useState, useSyncExternalStore } from "react";
import { WriteOnlySubmission } from "../service/write-only-submission.js";

/**
 * A secret form's submission, kept outside React Query so no shared cache holds the value. It
 * re-renders on every change and erases its draft when the form unmounts.
 */
export function useWriteOnlySubmission<T>(): WriteOnlySubmission<T> {
  const [submission] = useState(() => new WriteOnlySubmission<T>());
  useSyncExternalStore(submission.subscribe, submission.version);
  useEffect(() => {
    submission.open();
    return () => submission.close();
  }, [submission]);
  return submission;
}
