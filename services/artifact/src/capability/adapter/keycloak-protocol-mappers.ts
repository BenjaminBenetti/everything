/** A Keycloak protocol mapper, as the adapter defines one and as Keycloak returns it. */
export interface ProtocolMapperDefinition {
  readonly name: string;
  readonly protocol: string;
  readonly protocolMapper: string;
  readonly config: Readonly<Record<string, string>>;
}

/**
 * Whether stored mappers mean exactly the expected ones: the same names, protocols, mapper types,
 * and settings, with no mapper missing, repeated, or extra. Keycloak treats two token settings that
 * are absent as defaults, and may store them filled in, so both sides are compared with them filled.
 */
export function sameProtocolMappers(
  stored: unknown,
  expected: readonly ProtocolMapperDefinition[],
): boolean {
  const wanted = new Map(expected.map((mapper) => [mapper.name, mapper]));
  if (
    wanted.size !== expected.length ||
    !Array.isArray(stored) ||
    stored.length !== expected.length
  )
    return false;
  for (const mapper of stored as unknown[]) {
    if (!isMapper(mapper)) return false;
    const definition = wanted.get(mapper.name);
    if (
      !definition ||
      mapper.protocol !== definition.protocol ||
      mapper.protocolMapper !== definition.protocolMapper ||
      !sameSettings(effective(mapper.config), effective(definition.config))
    )
      return false;
    wanted.delete(mapper.name);
  }
  return wanted.size === 0;
}

/**
 * A mapper's settings as Keycloak applies them: unless set, a claim goes to UserInfo when it goes to
 * the ID token, and to token introspection when it goes to the access token.
 */
function effective(
  config: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...config,
    "userinfo.token.claim":
      config["userinfo.token.claim"] ??
      String(config["id.token.claim"] === "true"),
    "introspection.token.claim":
      config["introspection.token.claim"] ??
      String(config["access.token.claim"] === "true"),
  };
}

/** Whether two settings maps hold exactly the same keys and values. */
function sameSettings(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}

/** Whether a stored value is a mapper whose settings are all strings. */
function isMapper(value: unknown): value is ProtocolMapperDefinition {
  if (typeof value !== "object" || value === null) return false;
  const mapper = value as Record<string, unknown>;
  return (
    typeof mapper.name === "string" &&
    typeof mapper.protocol === "string" &&
    typeof mapper.protocolMapper === "string" &&
    typeof mapper.config === "object" &&
    mapper.config !== null &&
    !Array.isArray(mapper.config) &&
    Object.values(mapper.config).every((setting) => typeof setting === "string")
  );
}
