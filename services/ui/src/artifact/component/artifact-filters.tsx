import { Database, Cable, UserRound } from "lucide-react";
import { Select, MultiSelect } from "@everything/ui/select";
import { TeammateAvatar } from "../../agent/component/teammate-avatar.js";
import type { AppCreator, AppFilters } from "../model/artifact-filters.js";

/** Combine creator, serving type, and optional capabilities using themed, accessible controls. */
export function ArtifactFilters({
  value,
  creators,
  onChange,
}: {
  value: AppFilters;
  creators: readonly AppCreator[];
  onChange: (value: AppFilters) => void;
}) {
  return (
    <div className="artifact-filters" role="group" aria-label="Filter apps">
      <div className="artifact-filter-field artifact-filter-teammate">
        <Select
          label="Filter by teammate"
          placeholder="All teammates"
          value={value.creatorId}
          options={[
            { value: "", label: "All teammates" },
            ...creators.map((creator) => ({
              value: creator.id,
              label: creator.name,
              icon: creator.avatarId ? (
                <TeammateAvatar avatarId={creator.avatarId} small />
              ) : (
                <UserRound />
              ),
            })),
          ]}
          onValueChange={(creatorId) => onChange({ ...value, creatorId })}
        />
      </div>
      <div className="artifact-filter-field artifact-filter-type">
        <Select
          label="Filter by app type"
          placeholder="All types"
          value={value.kind}
          options={[
            { value: "", label: "All types" },
            { value: "static", label: "Static" },
            { value: "dynamic", label: "Dynamic" },
          ]}
          onValueChange={(kind) => {
            if (kind === "" || kind === "static" || kind === "dynamic")
              onChange({ ...value, kind });
          }}
        />
      </div>
      <div className="artifact-filter-field artifact-filter-capabilities">
        <MultiSelect
          label="Filter by capabilities"
          placeholder="All capabilities"
          value={[
            ...(value.database ? ["database"] : []),
            ...(value.api ? ["everything-api"] : []),
          ]}
          options={[
            { value: "database", label: "DB", icon: <Database /> },
            { value: "everything-api", label: "API", icon: <Cable /> },
          ]}
          onValueChange={(capabilities) =>
            onChange({
              ...value,
              database: capabilities.includes("database"),
              api: capabilities.includes("everything-api"),
            })
          }
        />
      </div>
    </div>
  );
}
