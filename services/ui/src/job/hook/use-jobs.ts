import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateJobInput,
  JobSchedule,
  UpdateJobInput,
} from "@everything/agent-contracts/job";
import { useSession } from "../../session/component/session-provider.js";
import { useJobClient } from "../component/job-client-provider.js";

/** Partition job data by signed-in account and teammate. */
function useJobsKey(agentId: string) {
  const { profile } = useSession();
  return ["jobs", profile?.subject, agentId] as const;
}

/** The teammate's jobs, refreshed while the chat is open so run states stay current. */
export function useJobs(agentId: string) {
  const client = useJobClient();
  const queryKey = useJobsKey(agentId);
  return useQuery({
    queryKey,
    queryFn: ({ signal }) => client.list(agentId, signal),
    enabled: !!queryKey[1],
    staleTime: 5_000,
    refetchInterval: 10_000,
    retry: false,
  });
}

/** A job's recent runs, refreshed more often while its details are open. */
export function useJobRuns(agentId: string, jobId: string) {
  const client = useJobClient();
  const key = useJobsKey(agentId);
  return useQuery({
    queryKey: [...key, jobId, "runs"],
    queryFn: ({ signal }) => client.runs(agentId, jobId, signal),
    enabled: !!key[1],
    staleTime: 2_000,
    refetchInterval: 5_000,
    retry: false,
  });
}

/**
 * The server's preview of a schedule, requested once the user pauses typing. `current` is false
 * until the query answers for the schedule as it is now, so an earlier schedule's times or error
 * are never shown for a newer one.
 */
export function useJobPreview(
  agentId: string,
  schedule: JobSchedule | undefined,
) {
  const client = useJobClient();
  const key = useJobsKey(agentId);
  const settled = useDebounced(schedule, 400);
  const query = useQuery({
    queryKey: [...key, "preview", JSON.stringify(settled ?? null)],
    queryFn: ({ signal }) => client.preview(agentId, settled!, signal),
    enabled: !!key[1] && !!settled,
    staleTime: 30_000,
    retry: false,
  });
  const current =
    JSON.stringify(settled ?? null) === JSON.stringify(schedule ?? null);
  return { query, current };
}

/** Job changes, each refreshing the list and run history when it settles. */
export function useJobActions(agentId: string) {
  const client = useJobClient();
  const cache = useQueryClient();
  const key = useJobsKey(agentId);
  const refresh = () => cache.invalidateQueries({ queryKey: key });
  const options = { onSettled: refresh } as const;
  return {
    create: useMutation({
      mutationFn: (input: CreateJobInput) => client.create(agentId, input),
      ...options,
    }),
    update: useMutation({
      mutationFn: ({
        jobId,
        input,
      }: {
        jobId: string;
        input: UpdateJobInput;
      }) => client.update(agentId, jobId, input),
      ...options,
    }),
    remove: useMutation({
      mutationFn: (jobId: string) => client.remove(agentId, jobId),
      ...options,
    }),
    runNow: useMutation({
      mutationFn: (jobId: string) => client.runNow(agentId, jobId),
      ...options,
    }),
    stop: useMutation({
      mutationFn: (jobId: string) => client.stop(agentId, jobId),
      ...options,
    }),
  };
}

/** The value once it has stopped changing for `delay` milliseconds. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  const serialized = JSON.stringify(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
    // The serialized form changes exactly when the value's content does.
  }, [serialized, delay]);
  return settled;
}
