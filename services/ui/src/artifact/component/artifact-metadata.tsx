import {
  Cable,
  Database,
  FileCode2,
  LockKeyhole,
  Server,
  UserRound,
} from "lucide-react";
import type { ArtifactSummary } from "@everything/artifact-contracts";
import { TeammateAvatar } from "../../agent/component/teammate-avatar.js";
import type { AppCreator } from "../model/artifact-filters.js";
import { credentialStatusLabels } from "../model/credential-presentation.js";
import { ArtifactApiKey } from "./artifact-api-key.js";
import { ArtifactIndicator } from "./artifact-indicator.js";

/** Show the original creator and the serving type and capabilities of the current release. */
export function ArtifactMetadata({
  artifact,
  creator,
}: {
  artifact: ArtifactSummary;
  creator: AppCreator;
}) {
  return (
    <div className="artifact-metadata">
      <div className="artifact-creator">
        <ArtifactIndicator
          label={`Created by ${creator.name}`}
          description={`Created by ${creator.name}`}
        >
          {creator.avatarId ? (
            <TeammateAvatar avatarId={creator.avatarId} small />
          ) : (
            <span className="artifact-creator-fallback">
              <UserRound aria-hidden="true" />
            </span>
          )}
        </ArtifactIndicator>
        <span className="artifact-creator-name">{creator.name}</span>
      </div>
      <div
        className="artifact-capabilities"
        role="group"
        aria-label="App capabilities"
      >
        {artifact.kind === "static" ? (
          <ArtifactIndicator
            label="Static app"
            description="Static app: serves published files."
          >
            <FileCode2 aria-hidden="true" />
          </ArtifactIndicator>
        ) : (
          <ArtifactIndicator
            label="Dynamic app"
            description="Dynamic app: runs a backend service."
          >
            <Server aria-hidden="true" />
          </ArtifactIndicator>
        )}
        {artifact.database && (
          <ArtifactIndicator
            label="Database"
            description="Database: stores app data in PostgreSQL."
          >
            <Database aria-hidden="true" />
          </ArtifactIndicator>
        )}
        {artifact.capabilities.includes("everything-api") && (
          <ArtifactIndicator
            label="Everything API"
            description="API: acts as you through the Everything API. It can ask your teammates to do things, including changing apps and their credentials."
          >
            <Cable aria-hidden="true" />
          </ArtifactIndicator>
        )}
        {artifact.capabilities.includes("api-key") && (
          <ArtifactApiKey appId={artifact.id} title={artifact.title} />
        )}
        {artifact.kind === "dynamic" && !!artifact.credentials?.length && (
          <ArtifactIndicator
            label="Credentials"
            description={`Credentials: ${artifact.credentials
              .map(
                (credential) =>
                  `${credential.env} ← ${credential.name ?? "deleted credential"} (${credentialStatusLabels[credential.status]})`,
              )
              .join("; ")}.`}
          >
            <LockKeyhole aria-hidden="true" />
          </ArtifactIndicator>
        )}
      </div>
    </div>
  );
}
