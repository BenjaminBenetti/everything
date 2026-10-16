/** Trusted claims set only by the app client provisioner. */
export const everythingAppClaims = {
  owner: "everything_app_owner",
  app: "everything_app_id",
} as const;

/** Namespace reserved for clients provisioned for dynamic apps. */
export const everythingAppClientPrefix = "everything-app-";

/** Derive a stable client ID from an app UUID, independent of its editable slug. */
export function everythingAppClientId(appId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      appId,
    )
  )
    throw new Error("Expected an app UUID");
  return `${everythingAppClientPrefix}${appId}`;
}
