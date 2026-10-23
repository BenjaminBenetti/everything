import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  artifactLimits,
  artifactCapabilities,
  artifactSlugPattern,
  environmentNamePattern,
} from "@everything/artifact-contracts";
import { appCredentialLimits } from "@everything/artifact-contracts/credential";
import { keyLimits } from "@everything/key-contracts";
import {
  maximumBuildWaitSeconds,
  type ArtifactWorkbench,
  type WorkbenchContext,
} from "../../artifact/service/artifact-workbench.js";
import type { TeammateArtifactView } from "../../artifact/interface/artifact-gateway.js";

/** Tool names, shared by the prompt and the tool allowlist. */
export const appToolNames = {
  create: "create_app",
  list: "list_apps",
  get: "get_app",
  update: "update_app",
  delete: "delete_app",
  checkout: "checkout_app",
  publish: "publish_app",
  build: "build_app",
  getBuild: "get_app_build",
  deploy: "deploy_app",
  stop: "stop_app",
  logs: "get_app_logs",
  view: "view_app",
  credentials: "list_credentials",
} as const;

/** An app named by slug or ID. */
const appReference = Type.String({
  minLength: 1,
  maxLength: 200,
  description: "The app's slug or ID.",
});

/** A release number to protect against overwriting a teammate's newer release. */
const basedOn = Type.Optional(
  Type.Integer({
    minimum: 0,
    description:
      "The release you started from, from checkout_app or get_app. If a teammate released since, the call fails instead of overwriting their work.",
  }),
);

/** Environment variables or build arguments. */
function variables(description: string, maxProperties: number) {
  return Type.Optional(
    Type.Record(
      Type.String({ pattern: environmentNamePattern }),
      Type.String({ maxLength: artifactLimits.envValueLength }),
      { maxProperties, additionalProperties: false, description },
    ),
  );
}

/** Quote a value as one Bash word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The teammate pod's browser, run once per command without a display or sandbox. */
const browser = "chromium --headless --no-sandbox";

/** Ready-to-run commands that view an app from the teammate's pod with its pass. */
function viewCommands(view: TeammateArtifactView) {
  return {
    fetch: `curl -sS -i -H ${shellQuote(`Authorization: Bearer ${view.token}`)} ${shellQuote(view.url)}`,
    screenshot: `${browser} --window-size=1280,800 --screenshot=/tmp/screenshot.png ${shellQuote(view.browserUrl)}`,
    renderedHtml: `${browser} --dump-dom ${shellQuote(view.browserUrl)}`,
  };
}

/** A tool result the model reads as JSON. */
function reply(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    details: {},
  };
}

/** Create the tools that let a teammate create, release, and inspect shared apps. */
export function appTools(
  workbench: ArtifactWorkbench,
  context: WorkbenchContext,
) {
  return [
    defineTool({
      name: appToolNames.create,
      label: "Create app",
      description:
        'Create a shared app: a page or application with its own link that the user and every teammate can open and change. Use kind "static" to publish files such as HTML, CSS, JavaScript, and images, or "dynamic" to build and run a container from a Dockerfile. The slug names the link and, like the kind, never changes. Nothing is visible until you publish (static) or deploy (dynamic).',
      parameters: Type.Object(
        {
          slug: Type.String({
            pattern: artifactSlugPattern,
            maxLength: artifactLimits.slugLength,
            description:
              'Lowercase letters, digits, and hyphens, such as "trip-planner".',
          }),
          kind: Type.Union([Type.Literal("static"), Type.Literal("dynamic")]),
          title: Type.String({
            minLength: 1,
            maxLength: artifactLimits.titleLength,
          }),
          description: Type.Optional(
            Type.String({ maxLength: artifactLimits.descriptionLength }),
          ),
        },
        { additionalProperties: false },
      ),
      /** Create an unpublished app for the teammate’s owner. */
      async execute(_id, parameters, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.create(context, parameters));
      },
    }),
    defineTool({
      name: appToolNames.list,
      label: "List apps",
      description:
        "List every shared app with its kind, status, live release, link, and the teammates who created and last changed it. Check this before creating an app, and extend an existing one when it fits.",
      parameters: Type.Object({}, { additionalProperties: false }),
      /** List all apps the teammate’s owner can access. */
      async execute(_id, _parameters, signal) {
        signal?.throwIfAborted();
        return reply({ apps: await workbench.list(context) });
      },
    }),
    defineTool({
      name: appToolNames.get,
      label: "Get app",
      description:
        "Show one app: its link, status, live release, recent revisions (static) or builds and live deployment (dynamic), and runtime state.",
      parameters: Type.Object(
        { app: appReference },
        { additionalProperties: false },
      ),
      /** Read details of the app identified by the model. */
      async execute(_id, parameters, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.get(context, parameters.app));
      },
    }),
    defineTool({
      name: appToolNames.update,
      label: "Update app",
      description:
        "Change an app's title or description. Its slug and kind never change.",
      parameters: Type.Object(
        {
          app: appReference,
          title: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: artifactLimits.titleLength,
            }),
          ),
          description: Type.Optional(
            Type.String({ maxLength: artifactLimits.descriptionLength }),
          ),
        },
        { additionalProperties: false },
      ),
      /** Change the app’s title or description. */
      async execute(_id, { app, ...changes }, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.update(context, app, changes));
      },
    }),
    defineTool({
      name: appToolNames.delete,
      label: "Delete app",
      description:
        "Permanently delete an app with its history, images, running container, database, and disk. Its link stops working for everyone. Only do this when the user asks.",
      parameters: Type.Object(
        { app: appReference },
        { additionalProperties: false },
      ),
      /** Delete the selected app and report completion. */
      async execute(_id, parameters, signal) {
        signal?.throwIfAborted();
        await workbench.delete(context, parameters.app);
        return reply(`Deleted ${parameters.app}.`);
      },
    }),
    defineTool({
      name: appToolNames.checkout,
      label: "Check out app",
      description:
        'Copy an app\'s source files into a directory in your workspace, so you can change them and publish or build again, including work another teammate started. By default this copies the live release (or, for a dynamic app that was never deployed, its newest build). The result includes "release": pass it as basedOn when you publish or deploy.',
      parameters: Type.Object(
        {
          app: appReference,
          directory: Type.String({
            minLength: 1,
            description:
              "Directory in your workspace or the shared folder to copy into; it must be empty unless overwrite is true.",
          }),
          revision: Type.Optional(
            Type.Integer({
              minimum: 1,
              description: "A static app's revision to copy instead.",
            }),
          ),
          build: Type.Optional(
            Type.Integer({
              minimum: 1,
              description: "A dynamic app's build to copy instead.",
            }),
          ),
          overwrite: Type.Optional(
            Type.Boolean({
              description:
                "Replace files with the same paths in a non-empty directory.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      /** Copy the app’s source into the requested workspace directory. */
      async execute(_id, { app, ...input }, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.checkout(context, app, input));
      },
    }),
    defineTool({
      name: appToolNames.publish,
      label: "Publish app",
      description:
        "Publish a directory from your workspace as the next revision of a static app and make it live. Its files are served at the app's link with paths relative to the directory, and index.html is the default page. Use relative links so pages work under the app's path. To roll back, pass revision instead of directory.",
      parameters: Type.Object(
        {
          app: appReference,
          directory: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                "Directory in your workspace or the shared folder to publish.",
            }),
          ),
          revision: Type.Optional(
            Type.Integer({
              minimum: 1,
              description: "An earlier revision to make live again.",
            }),
          ),
          basedOn,
        },
        { additionalProperties: false },
      ),
      /** Publish files or activate an earlier app revision. */
      async execute(_id, { app, ...input }, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.publish(context, app, input));
      },
    }),
    defineTool({
      name: appToolNames.build,
      label: "Build app",
      description:
        "Build a container image for a dynamic app from a directory in your workspace that holds a Dockerfile; .dockerignore is respected. The build runs in the background and this returns its number right away: follow it with get_app_build, then run it with deploy_app. The image must run as a non-root user and listen on the PORT variable. Serve routes from /: requests arrive without the app's /slug prefix. Use the BASE_PATH variable, which holds that prefix, only to build absolute links and asset URLs, or use relative links; root-relative redirects are prefixed automatically.",
      parameters: Type.Object(
        {
          app: appReference,
          context: Type.String({
            minLength: 1,
            description:
              "Directory in your workspace or the shared folder to build from.",
          }),
          dockerfile: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                "Path of the Dockerfile inside the directory. Defaults to Dockerfile.",
            }),
          ),
          buildArgs: variables(
            "Build arguments passed to the Dockerfile.",
            artifactLimits.buildArgCount,
          ),
        },
        { additionalProperties: false },
      ),
      /** Build the app from the requested workspace directory. */
      async execute(_id, { app, ...input }, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.build(context, app, input));
      },
    }),
    defineTool({
      name: appToolNames.getBuild,
      label: "Get app build",
      description: `Show a build's status and the end of its log. Pass waitSeconds (up to ${maximumBuildWaitSeconds}) to wait for the build to finish; waiting stops early if the user sends a message.`,
      parameters: Type.Object(
        {
          app: appReference,
          build: Type.Integer({ minimum: 1 }),
          waitSeconds: Type.Optional(
            Type.Integer({ minimum: 0, maximum: maximumBuildWaitSeconds }),
          ),
        },
        { additionalProperties: false },
      ),
      /** Wait for the app’s build, preserving cancellation. */
      async execute(_id, parameters, signal) {
        return reply(
          await workbench.waitForBuild(
            context,
            parameters.app,
            parameters.build,
            parameters.waitSeconds ?? 0,
            signal,
          ),
        );
      },
    }),
    defineTool({
      name: appToolNames.deploy,
      label: "Deploy app",
      description:
        'Run a successful build of a dynamic app as its next release; the latest successful build by default. Settings you leave out keep their current values; a first deployment uses port 8080, no variables, no database, no capabilities, and no disk. database: true gives the app its own PostgreSQL schema through DATABASE_URL and the PG* variables. capabilities: ["everything-api"] gives its backend EVERYTHING_API_URL, EVERYTHING_CLIENT_ID, EVERYTHING_CLIENT_SECRET, and EVERYTHING_TOKEN_URL. POST grant_type=client_credentials, client_id, and client_secret as form data to EVERYTHING_TOKEN_URL, then send the access_token as Authorization: Bearer to EVERYTHING_API_URL + /v1/...; this acts as the app owner, with the owner\'s full access, including messaging teammates, who can change apps and attach credentials to them, so give it only to apps the user trusts. Keep credentials and tokens on the backend. Pass capabilities: [] to remove access; issued tokens expire within five minutes. capabilities: ["api-key"] lets external services such as webhooks call the app at its link by sending its key in an X-Api-Key header; the app host checks the key and removes the header, so the app doesn\'t need to. Its backend receives the key as APP_API_KEY, and the user can see it on Apps. Removing api-key revokes the key at once; adding it again creates a new key. capabilities replaces the whole list, so include every capability to keep. credentials gives the backend generic credentials the user saved on the Keys page, by name, each as the environment variable you choose, such as [{\"name\": \"slack-bot-token\", \"env\": \"SLACK_BOT_TOKEN\"}]; find names with list_credentials. The app keeps the credential even if it is renamed later. Attaching one lets the app\'s code read the value, so attach only what the app needs, keep it on the backend, and never print or return it. credentials replaces the whole list: omit it to keep the current ones, and pass [] to remove them all. Removing a credential restarts the app without it, and get_app lists it as removing until the old process has stopped; check get_app before telling the user it\'s gone. If the app\'s credentials changed while you were deploying, the call fails with CREDENTIAL_GRANTS_CHANGED: check the app again before retrying. Names can\'t be PORT, BASE_PATH, DATABASE_URL, APP_API_KEY, an ordinary env variable of the app, or start with EVERYTHING_, PG, or KUBERNETES_. diskGi mounts a persistent disk at /data; its size can\'t change once created. The app also receives PORT and BASE_PATH, the app\'s /slug prefix. Requests arrive without that prefix, so serve routes from / and use BASE_PATH only to build absolute links.',
      parameters: Type.Object(
        {
          app: appReference,
          build: Type.Optional(Type.Integer({ minimum: 1 })),
          port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
          env: variables(
            "Environment variables for the app.",
            artifactLimits.envCount,
          ),
          database: Type.Optional(Type.Boolean()),
          capabilities: Type.Optional(
            Type.Array(
              Type.Union(
                artifactCapabilities.map((name) => Type.Literal(name)),
              ),
              {
                uniqueItems: true,
                maxItems: artifactCapabilities.length,
                description:
                  "Backend services to provision. Omit to keep current capabilities; [] removes them.",
              },
            ),
          ),
          credentials: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  name: Type.String({
                    minLength: 1,
                    maxLength: keyLimits.nameLength,
                    description:
                      "Name of a generic credential on the Keys page, as list_credentials shows it.",
                  }),
                  env: Type.String({
                    pattern: environmentNamePattern,
                    maxLength: appCredentialLimits.envLength,
                    description:
                      "Environment variable the backend reads the value from, such as SLACK_BOT_TOKEN.",
                  }),
                },
                { additionalProperties: false },
              ),
              {
                maxItems: appCredentialLimits.count,
                description:
                  "Credentials the backend receives. Omit to keep the current ones; [] removes them.",
              },
            ),
          ),
          diskGi: Type.Optional(
            Type.Union([
              Type.Integer({ minimum: 1, maximum: artifactLimits.diskGi }),
              Type.Null(),
            ]),
          ),
          healthPath: Type.Optional(
            Type.Union([
              Type.String({
                pattern: "^/[^\\s]*$",
                description:
                  "Path that answers 200 when the app is ready, such as /health.",
              }),
              Type.Null(),
            ]),
          ),
          basedOn,
        },
        { additionalProperties: false },
      ),
      /** Deploy the selected build and runtime settings. */
      async execute(_id, { app, ...input }, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.deploy(context, app, input));
      },
    }),
    defineTool({
      name: appToolNames.stop,
      label: "Stop app",
      description:
        "Stop a published app. Its files, deployment, database, and disk are kept. The user can start it again from Apps, or you can publish or deploy it again.",
      parameters: Type.Object(
        { app: appReference },
        { additionalProperties: false },
      ),
      /** Stop the app while retaining its stored release and data. */
      async execute(_id, parameters, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.stop(context, parameters.app));
      },
    }),
    defineTool({
      name: appToolNames.logs,
      label: "Get app logs",
      description:
        "Show recent output from a dynamic app. Pass previous: true to read the run before the latest restart, for example after a crash.",
      parameters: Type.Object(
        {
          app: appReference,
          previous: Type.Optional(Type.Boolean()),
          lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
        },
        { additionalProperties: false },
      ),
      /** Read app output with bounded defaults. */
      async execute(_id, parameters, signal) {
        signal?.throwIfAborted();
        const logs = await workbench.logs(context, parameters.app, {
          previous: parameters.previous ?? false,
          lines: parameters.lines ?? 200,
        });
        return reply(logs.text || "The app has no output yet.");
      },
    }),
    defineTool({
      name: appToolNames.credentials,
      label: "List credentials",
      description:
        "List the generic credentials you can give your apps with deploy_app: each one's name, description, when its value last changed, and which apps receive it as which variable. Values are never shown, and no tool reveals them. If a credential an app needs is missing, ask the user to add it on the Keys page.",
      parameters: Type.Object({}, { additionalProperties: false }),
      /** List the owner's attachable credentials without values. */
      async execute(_id, _parameters, signal) {
        signal?.throwIfAborted();
        return reply({ credentials: await workbench.listCredentials(context) });
      },
    }),
    defineTool({
      name: appToolNames.view,
      label: "View app",
      description:
        "Open an app from your pod the way the user sees it, to check that a publish or deployment works: read its HTML, call its API, or take a screenshot. Returns a pass that works for a few minutes, only for this app, and only inside the cluster. Send token as an Authorization: Bearer header to url, or open browserUrl in Chromium, which signs the browser in and then opens the page; call again for a new pass or another page. The result includes ready-to-run curl and Chromium commands for bash. These links don't work for the user, so share the app's own link instead.",
      parameters: Type.Object(
        {
          app: appReference,
          path: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: artifactLimits.viewPathLength,
              description:
                "Page inside the app to open, starting with /, such as /docs/?tab=2. Defaults to its home page.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      /** Issue an app viewing pass and commands to check the result. */
      async execute(_id, { app, ...input }, signal) {
        signal?.throwIfAborted();
        const view = await workbench.view(context, app, input);
        return reply({ ...view, commands: viewCommands(view) });
      },
    }),
  ];
}
