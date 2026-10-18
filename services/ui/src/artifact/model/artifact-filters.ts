import type { Agent } from "@everything/agent-contracts";
import type {
  ArtifactKind,
  ArtifactSummary,
} from "@everything/artifact-contracts";

/** Independent app filters; selected capabilities must all be present. */
export interface AppFilters {
  readonly creatorId: string;
  readonly kind: ArtifactKind | "";
  readonly database: boolean;
  readonly api: boolean;
  readonly apiKey: boolean;
}

/** Show every app until a filter is selected. */
export const allApps: AppFilters = {
  creatorId: "",
  kind: "",
  database: false,
  api: false,
  apiKey: false,
};

/** Creator identity uses the current profile where available, or the saved author after deletion. */
export type AppCreator = Pick<Agent, "id" | "name"> &
  Partial<Pick<Agent, "avatarId">>;

/** Keep every app creator selectable, independently of the active filters or directory availability. */
export function appCreators(
  apps: readonly ArtifactSummary[],
  agents: readonly Pick<Agent, "id" | "name" | "avatarId">[] = [],
): AppCreator[] {
  const directory = new Map(agents.map((agent) => [agent.id, agent]));
  const creators = new Map<string, AppCreator>();
  for (const { createdBy } of apps) {
    const current = directory.get(createdBy.id);
    creators.set(createdBy.id, current ?? createdBy);
  }
  return [...creators.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

/** Match the original creator and all requested deployment features. */
export function matchesAppFilters(
  app: ArtifactSummary,
  filters: AppFilters,
): boolean {
  return (
    (!filters.creatorId || app.createdBy.id === filters.creatorId) &&
    (!filters.kind || app.kind === filters.kind) &&
    (!filters.database || app.database) &&
    (!filters.api || app.capabilities.includes("everything-api")) &&
    (!filters.apiKey || app.capabilities.includes("api-key"))
  );
}
