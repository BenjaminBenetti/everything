/**
 * Variables commands inherit from the API process, as defined by the teammate image: the locale,
 * toolchain locations, user-level install and cache directories, and the system browser. Everything
 * else, including the pod's API token and the API's own settings, never reaches a command.
 */
export const commandVariables = [
  "PATH",
  "LANG",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "NPM_CONFIG_PREFIX",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_UPDATE_NOTIFIER",
  "PIP_DISABLE_PIP_VERSION_CHECK",
  "GEM_HOME",
  "BUNDLE_USER_CACHE",
  "GOPATH",
  "GOBIN",
  "GOMODCACHE",
  "CHROME_PATH",
  "PUPPETEER_EXECUTABLE_PATH",
  "PUPPETEER_SKIP_DOWNLOAD",
  "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
  "PLAYWRIGHT_MCP_EXECUTABLE_PATH",
] as const;

/** Values used when the API process does not define a variable, such as outside the image. */
const fallbacks: Readonly<Record<string, string>> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  LANG: "C.UTF-8",
  TMPDIR: "/tmp",
};

/** Copy only the allowlisted variables from `source`, falling back to a minimal shell environment. */
export function commandEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { ...fallbacks };
  for (const name of commandVariables) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
