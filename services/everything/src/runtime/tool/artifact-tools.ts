import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  artifactLimits,
  artifactSlugPattern,
  environmentNamePattern,
} from "@everything/artifact-contracts";
import {
  maximumBuildWaitSeconds,
  type ArtifactWorkbench,
  type WorkbenchContext,
} from "../../artifact/service/artifact-workbench.js";
import type { TeammateArtifactView } from "../../artifact/interface/artifact-gateway.js";

/** Tool names, shared by the prompt and the tool allowlist. */
export const artifactToolNames = {
  create: "create_artifact",
  list: "list_artifacts",
  get: "get_artifact",
  update: "update_artifact",
  delete: "delete_artifact",
  checkout: "checkout_artifact",
  publish: "publish_artifact",
  build: "build_artifact",
  getBuild: "get_artifact_build",
  deploy: "deploy_artifact",
  stop: "stop_artifact",
  logs: "get_artifact_logs",
  view: "view_artifact",
} as const;

/** An artifact named by slug or ID. */
const artifactReference = Type.String({
  minLength: 1,
  maxLength: 200,
  description: "The artifact's slug or ID.",
});

/** A release number to protect against overwriting a teammate's newer release. */
const basedOn = Type.Optional(
  Type.Integer({
    minimum: 0,
    description:
      "The release you started from, from checkout_artifact or get_artifact. If a teammate released since, the call fails instead of overwriting their work.",
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

/** Ready-to-run commands that view an artifact from the teammate's pod with its pass. */
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

/** Create the tools that let a teammate create, release, and inspect shared artifacts. */
export function artifactTools(
  workbench: ArtifactWorkbench,
  context: WorkbenchContext,
) {
  return [
    defineTool({
      name: artifactToolNames.create,
      label: "Create artifact",
      description:
        'Create a shared artifact: a page or app with its own link that the user and every teammate can open and change. Use kind "static" to publish files such as HTML, CSS, JavaScript, and images, or "dynamic" to build and run a container from a Dockerfile. The slug names the link and, like the kind, never changes. Nothing is visible until you publish (static) or deploy (dynamic).',
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
      async execute(_id, parameters, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.create(context, parameters));
      },
    }),
    defineTool({
      name: artifactToolNames.list,
      label: "List artifacts",
      description:
        "List every shared artifact with its kind, status, live release, link, and the teammates who created and last changed it. Check this before creating an artifact, and extend an existing one when it fits.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, _parameters, signal) {
        signal?.throwIfAborted();
        return reply({ artifacts: await workbench.list(context) });
      },
    }),
    defineTool({
      name: artifactToolNames.get,
      label: "Get artifact",
      description:
        "Show one artifact: its link, status, live release, recent revisions (static) or builds and live deployment (dynamic), and runtime state.",
      parameters: Type.Object(
        { artifact: artifactReference },
        { additionalProperties: false },
      ),
      async execute(_id, parameters, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.get(context, parameters.artifact));
      },
    }),
    defineTool({
      name: artifactToolNames.update,
      label: "Update artifact",
      description:
        "Change an artifact's title or description. Its slug and kind never change.",
      parameters: Type.Object(
        {
          artifact: artifactReference,
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
      async execute(_id, { artifact, ...changes }, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.update(context, artifact, changes));
      },
    }),
    defineTool({
      name: artifactToolNames.delete,
      label: "Delete artifact",
      description:
        "Permanently delete an artifact with its history, images, running app, database, and disk. Its link stops working for everyone. Only do this when the user asks.",
      parameters: Type.Object(
        { artifact: artifactReference },
        { additionalProperties: false },
      ),
      async execute(_id, parameters, signal) {
        signal?.throwIfAborted();
        await workbench.delete(context, parameters.artifact);
        return reply(`Deleted ${parameters.artifact}.`);
      },
    }),
    defineTool({
      name: artifactToolNames.checkout,
      label: "Check out artifact",
      description:
        'Copy an artifact\'s source files into a directory in your workspace, so you can change them and publish or build again, including work another teammate started. By default this copies the live release (or, for a dynamic artifact that was never deployed, its newest build). The result includes "release": pass it as basedOn when you publish or deploy.',
      parameters: Type.Object(
        {
          artifact: artifactReference,
          directory: Type.String({
            minLength: 1,
            description:
              "Directory in your workspace to copy into; it must be empty unless overwrite is true.",
          }),
          revision: Type.Optional(
            Type.Integer({
              minimum: 1,
              description: "A static artifact's revision to copy instead.",
            }),
          ),
          build: Type.Optional(
            Type.Integer({
              minimum: 1,
              description: "A dynamic artifact's build to copy instead.",
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
      async execute(_id, { artifact, ...input }, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.checkout(context, artifact, input));
      },
    }),
    defineTool({
      name: artifactToolNames.publish,
      label: "Publish artifact",
      description:
        "Publish a directory from your workspace as the next revision of a static artifact and make it live. Its files are served at the artifact's link with paths relative to the directory, and index.html is the default page. Use relative links so pages work under the artifact's path. To roll back, pass revision instead of directory.",
      parameters: Type.Object(
        {
          artifact: artifactReference,
          directory: Type.Optional(
            Type.String({
              minLength: 1,
              description: "Directory in your workspace to publish.",
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
      async execute(_id, { artifact, ...input }, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.publish(context, artifact, input));
      },
    }),
    defineTool({
      name: artifactToolNames.build,
      label: "Build artifact",
      description:
        "Build a container image for a dynamic artifact from a directory in your workspace that holds a Dockerfile; .dockerignore is respected. The build runs in the background and this returns its number right away: follow it with get_artifact_build, then run it with deploy_artifact. The image must run as a non-root user and listen on the PORT variable. Serve routes from /: requests arrive without the artifact's /slug prefix. Use the BASE_PATH variable, which holds that prefix, only to build absolute links and asset URLs, or use relative links; root-relative redirects are prefixed automatically.",
      parameters: Type.Object(
        {
          artifact: artifactReference,
          context: Type.String({
            minLength: 1,
            description: "Directory in your workspace to build from.",
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
      async execute(_id, { artifact, ...input }, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.build(context, artifact, input));
      },
    }),
    defineTool({
      name: artifactToolNames.getBuild,
      label: "Get artifact build",
      description: `Show a build's status and the end of its log. Pass waitSeconds (up to ${maximumBuildWaitSeconds}) to wait for the build to finish; waiting stops early if the user sends a message.`,
      parameters: Type.Object(
        {
          artifact: artifactReference,
          build: Type.Integer({ minimum: 1 }),
          waitSeconds: Type.Optional(
            Type.Integer({ minimum: 0, maximum: maximumBuildWaitSeconds }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_id, parameters, signal) {
        return reply(
          await workbench.waitForBuild(
            context,
            parameters.artifact,
            parameters.build,
            parameters.waitSeconds ?? 0,
            signal,
          ),
        );
      },
    }),
    defineTool({
      name: artifactToolNames.deploy,
      label: "Deploy artifact",
      description:
        "Run a successful build of a dynamic artifact as its next release; the latest successful build by default. Settings you leave out keep their current values; a first deployment uses port 8080, no variables, no database, and no disk. database: true gives the app its own PostgreSQL schema through DATABASE_URL and the PG* variables. diskGi mounts a persistent disk at /data; its size can't change once created. The app also receives PORT and BASE_PATH, the artifact's /slug prefix. Requests arrive without that prefix, so serve routes from / and use BASE_PATH only to build absolute links.",
      parameters: Type.Object(
        {
          artifact: artifactReference,
          build: Type.Optional(Type.Integer({ minimum: 1 })),
          port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
          env: variables(
            "Environment variables for the app.",
            artifactLimits.envCount,
          ),
          database: Type.Optional(Type.Boolean()),
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
      async execute(_id, { artifact, ...input }, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.deploy(context, artifact, input));
      },
    }),
    defineTool({
      name: artifactToolNames.stop,
      label: "Stop artifact",
      description:
        "Stop a dynamic artifact's app. Its deployment, database, and disk are kept; deploy again to restart it.",
      parameters: Type.Object(
        { artifact: artifactReference },
        { additionalProperties: false },
      ),
      async execute(_id, parameters, signal) {
        signal?.throwIfAborted();
        return reply(await workbench.stop(context, parameters.artifact));
      },
    }),
    defineTool({
      name: artifactToolNames.logs,
      label: "Get artifact logs",
      description:
        "Show recent output from a dynamic artifact's app. Pass previous: true to read the run before the latest restart, for example after a crash.",
      parameters: Type.Object(
        {
          artifact: artifactReference,
          previous: Type.Optional(Type.Boolean()),
          lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, parameters, signal) {
        signal?.throwIfAborted();
        const logs = await workbench.logs(context, parameters.artifact, {
          previous: parameters.previous ?? false,
          lines: parameters.lines ?? 200,
        });
        return reply(logs.text || "The app has no output yet.");
      },
    }),
    defineTool({
      name: artifactToolNames.view,
      label: "View artifact",
      description:
        "Open an artifact from your pod the way the user sees it, to check that a publish or deployment works: read its HTML, call its API, or take a screenshot. Returns a pass that works for a few minutes, only for this artifact, and only inside the cluster. Send token as an Authorization: Bearer header to url, or open browserUrl in Chromium, which signs the browser in and then opens the page; call again for a new pass or another page. The result includes ready-to-run curl and Chromium commands for bash. These links don't work for the user, so share the artifact's own link instead.",
      parameters: Type.Object(
        {
          artifact: artifactReference,
          path: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: artifactLimits.viewPathLength,
              description:
                "Page inside the artifact to open, starting with /, such as /docs/?tab=2. Defaults to its home page.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_id, { artifact, ...input }, signal) {
        signal?.throwIfAborted();
        const view = await workbench.view(context, artifact, input);
        return reply({ ...view, commands: viewCommands(view) });
      },
    }),
  ];
}
