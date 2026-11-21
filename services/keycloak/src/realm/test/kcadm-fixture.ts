/**
 * A stand-in for Keycloak's admin CLI, for the provisioning script's tests. It answers the calls the
 * script makes from a JSON state file, the way kcadm.sh 26.8.2 prints them, and records each call
 * with its credential values masked, the credential cache's mode, and the changes it made.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

/** One client in the fake realm. */
export interface FixtureClient {
  id: string;
  clientId: string;
  protocol: string;
  publicClient: boolean;
  bearerOnly: boolean;
  serviceAccountsEnabled: boolean;
  defaultScopes: string[];
  optionalScopes: string[];
  secret?: string;
  attributes?: Record<string, string>;
}

/** The fake server: who may sign in, what the realm holds, and how calls fail. */
export interface FixtureState {
  admin: { username: string; password: string };
  realms: Record<
    string,
    {
      scopes: { id: string; name: string; protocol: string }[];
      clients: FixtureClient[];
      roles: Record<string, string[]>;
      sslRequired?: string;
    }
  >;
  /** Refuse connections, as a server that is not listening does. */
  down?: boolean;
  /** Answer `update .../default-client-scopes/...` with this error and change nothing. */
  scopeUpdateError?: string;
  /** Add the scope as another writer would, then fail the call. */
  scopeUpdateRaced?: boolean;
  /** Accept the update without adding the scope, as Keycloak does for a scope already linked. */
  scopeUpdateIgnored?: boolean;
  /** Hang on this call's first word, until the script's own time limit stops it. */
  hang?: string;
  calls: { args: string[]; configMode: string | null; configPath: string }[];
}

const statePath = process.env.KCADM_FIXTURE_STATE!;
const state = JSON.parse(readFileSync(statePath, "utf8")) as FixtureState;
const argv = process.argv.slice(2);

/** The value after a flag. */
function flag(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const configPath = flag("--config") ?? "";
const masked = argv.map((value, index) =>
  argv[index - 1] === "--password" ||
  argv[index - 1] === "--secret" ||
  value.startsWith("secret=")
    ? "***"
    : value,
);
state.calls.push({
  args: masked,
  configMode: existsSync(configPath)
    ? (statSync(configPath).mode & 0o777).toString(8)
    : null,
  configPath,
});

function save(): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function fail(message: string): never {
  save();
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function csv(rows: (string | boolean)[][], quoted: boolean): void {
  save();
  for (const row of rows)
    process.stdout.write(
      `${row.map((value) => (typeof value === "string" && quoted ? `"${value}"` : String(value))).join(",")}\n`,
    );
  process.exit(0);
}

const server = flag("--server") ?? "http://localhost:8080/auth";
const [verb, target] = argv;
if (state.hang && verb === state.hang) {
  save();
  setInterval(() => {}, 1000);
} else if (state.down) {
  if (verb === "config")
    process.stderr.write(
      `Logging into ${server} as user ${flag("--user")} of realm master\n`,
    );
  fail(
    "Failed to send request - Connect to localhost:8080 [localhost/127.0.0.1] failed: Connection refused",
  );
} else if (verb === "config" && target === "credentials") {
  process.stderr.write(
    `Logging into ${server} as user ${flag("--user")} of realm ${flag("--realm")}\n`,
  );
  if (
    flag("--user") !== state.admin.username ||
    flag("--password") !== state.admin.password
  )
    fail("Invalid user credentials [invalid_grant]");
  writeFileSync(configPath, '{"tokens":"fixture"}');
  save();
  process.exit(0);
} else if (!existsSync(configPath) || readFileSync(configPath, "utf8") === "") {
  fail("No server specified. Use --server, or 'kcadm.sh config credentials'.");
} else if (verb === "update" && target!.startsWith("realms/")) {
  const realm = state.realms[target!.slice("realms/".length)];
  if (!realm) fail(`Resource not found for url: ${server}/admin/${target}`);
  realm.sslRequired = "external";
  save();
  process.exit(0);
} else {
  const realmName = flag("-r")!;
  const realm = state.realms[realmName];
  if (!realm)
    fail(
      `Resource not found for url: ${server}/admin/realms/${realmName}/${target}`,
    );
  const client = (id: string) =>
    realm.clients.find((candidate) => candidate.id === id) ??
    fail(
      `Resource not found for url: ${server}/admin/realms/${realmName}/clients/${id}`,
    );
  let match: RegExpMatchArray | null;
  if (verb === "get" && target === "client-scopes")
    csv(
      realm.scopes.map((scope) => [scope.id, scope.name, scope.protocol]),
      true,
    );
  else if (verb === "get" && target === "clients") {
    const wanted = flag("-q")?.replace(/^clientId=/, "");
    const found = realm.clients.filter(
      (candidate) => candidate.clientId === wanted,
    );
    if (flag("--format") === "csv")
      csv(
        found.map((c) => [
          c.id,
          c.clientId,
          c.protocol,
          c.publicClient,
          c.bearerOnly,
          c.serviceAccountsEnabled,
        ]),
        true,
      );
    save();
    process.stdout.write(
      JSON.stringify(
        found.map((c) => ({ id: c.id })),
        null,
        2,
      ) + "\n",
    );
    process.exit(0);
  } else if (
    verb === "get" &&
    (match = target!.match(
      /^clients\/([^/]+)\/(default|optional)-client-scopes$/,
    ))
  ) {
    const found = client(match[1]!);
    csv(
      (match[2] === "default" ? found.defaultScopes : found.optionalScopes).map(
        (id) => [id],
      ),
      false,
    );
  } else if (
    verb === "update" &&
    (match = target!.match(
      /^clients\/([^/]+)\/default-client-scopes\/([^/]+)$/,
    ))
  ) {
    const found = client(match[1]!);
    if (!realm.scopes.some((scope) => scope.id === match![2]))
      fail(
        `Resource not found for url: ${server}/admin/realms/${realmName}/${target}`,
      );
    if (state.scopeUpdateError) fail(state.scopeUpdateError);
    const linked =
      found.defaultScopes.includes(match[2]!) ||
      found.optionalScopes.includes(match[2]!);
    if (!linked && !state.scopeUpdateIgnored)
      found.defaultScopes.push(match[2]!);
    if (state.scopeUpdateRaced) fail("HTTP 409 Conflict");
    save();
    process.exit(0);
  } else if (verb === "create" && target === "clients") {
    const id = `created-${realm.clients.length}`;
    const settings = Object.fromEntries(
      argv
        .flatMap((value, index) => (argv[index - 1] === "-s" ? [value] : []))
        .map((setting) => setting.split("=") as [string, string]),
    );
    realm.clients.push({
      id,
      clientId: settings.clientId!,
      protocol: settings.protocol!,
      publicClient: settings.publicClient === "true",
      bearerOnly: false,
      serviceAccountsEnabled: settings.serviceAccountsEnabled === "true",
      defaultScopes: [],
      optionalScopes: [],
    });
    save();
    process.stdout.write(`${id}\n`);
    process.exit(0);
  } else if (
    verb === "update" &&
    (match = target!.match(/^clients\/([^/]+)$/))
  ) {
    const found = client(match[1]!);
    for (const [index, value] of argv.entries())
      if (argv[index - 1] === "-s" && value.startsWith("secret="))
        found.secret = value.slice("secret=".length);
    save();
    process.exit(0);
  } else if (verb === "add-roles") {
    const user = flag("--uusername")!;
    realm.roles[user] = [
      ...new Set([
        ...(realm.roles[user] ?? []),
        `${flag("--cclientid")}/${flag("--rolename")}`,
      ]),
    ];
    save();
    process.exit(0);
  }
  fail(`The fixture does not answer: ${masked.join(" ")}`);
}
