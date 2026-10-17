/**
 * Variables commands inherit from the API process, as defined by the teammate image: the locale,
 * toolchain locations, cache directories, and the system browser. Everything else, including the
 * pod's API token and the API's own settings, never reaches a command.
 */
export const commandVariables = [
  "PATH",
  "SSH_AUTH_SOCK",
  "LANG",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_UPDATE_NOTIFIER",
  "PIP_DISABLE_PIP_VERSION_CHECK",
  "BUNDLE_USER_CACHE",
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

/**
 * Copy only the allowlisted variables from `source`, falling back to a minimal shell environment, and
 * make `home`, the teammate's workspace, the home of user-level installs: npm, gem, and Go install
 * there and their programs come first on PATH, so they persist with the workspace's files.
 */
export function commandEnvironment(
  source: NodeJS.ProcessEnv,
  home: string,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { ...fallbacks };
  for (const name of commandVariables) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  const local = `${home}/.local`;
  return {
    ...environment,
    HOME: home,
    PATH: `${local}/bin:${local}/share/gem/bin:${environment.PATH}`,
    NPM_CONFIG_PREFIX: local,
    GEM_HOME: `${local}/share/gem`,
    GOPATH: `${local}/share/go`,
    GOBIN: `${local}/bin`,
  };
}
