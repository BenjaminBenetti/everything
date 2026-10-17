import { Type, type Static } from "typebox";
import { releaseVersionPattern } from "@everything/upgrade-contracts";

/** A required, non-empty setting. */
const required = Type.String({ minLength: 1 });

/** A Kubernetes namespace or object name. */
const kubernetesName = Type.String({
  pattern: "^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$",
  maxLength: 253,
});

/** A released version of the chart, such as 1.2.3 or 1.2.3-rc.1. */
const releaseVersion = Type.String({ pattern: releaseVersionPattern });

/** Settings shared by the service and the upgrade Jobs it starts, which inherit its environment. */
const releaseSettings = {
  /** Released versions of the chart, as `oci://<registry>/<repository>`; empty turns upgrades off. */
  CHART: Type.String({ pattern: "^(oci://[^/\\s]+/[^\\s]+)?$", default: "" }),
  /** For a chart registry inside the cluster that serves plain HTTP rather than HTTPS. */
  CHART_PLAIN_HTTP: Type.Boolean({ default: false }),
  RELEASE_NAME: kubernetesName,
  RELEASE_NAMESPACE: kubernetesName,
  /** The installer's settings file; empty until the installer has saved it in the cluster. */
  SETTINGS_FILE: Type.String({ pattern: "^/" }),
};

/** Runtime-validated configuration of the upgrader service. */
export const environmentSchema = Type.Object({
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 8080 }),
  ...releaseSettings,
  /** The chart version installed, which the chart sets in this variable. */
  CURRENT_VERSION: releaseVersion,
  /** Audience of the service account tokens callers present, so they are valid nowhere else. */
  TOKEN_AUDIENCE: required,
  /** The only service account, in the release's namespace, allowed to call the API. */
  CALLER_SERVICE_ACCOUNT: kubernetesName,
});

/** Runtime-validated configuration of one upgrade Job. */
export const upgradeJobEnvironmentSchema = Type.Object({
  ...releaseSettings,
  /** The version the Job installs. */
  UPGRADE_VERSION: releaseVersion,
});

/** Service settings after env-schema validation and defaults. */
export type EnvironmentSettings = Static<typeof environmentSchema>;

/** Job settings after env-schema validation and defaults. */
export type UpgradeJobEnvironmentSettings = Static<
  typeof upgradeJobEnvironmentSchema
>;
