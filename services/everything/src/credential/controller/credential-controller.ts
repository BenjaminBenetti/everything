import type { FastifyInstance } from "fastify";
import {
  appParams,
  type AppParams,
} from "../../artifact/schema/artifact-request.js";
import { keyActor } from "../../key/controller/key-controller.js";
import { appCredentialListResponse } from "../../key/schema/key-response.js";
import {
  appCredentialParams,
  attachCredentialBody,
  type AppCredentialParams,
  type AttachCredentialBody,
} from "../schema/credential-request.js";
import type { CredentialGrants } from "../service/credential-grants.js";

/** Register the browser's endpoints that give an app a credential or take it away. */
export async function credentialController(
  app: FastifyInstance,
  grants: Pick<CredentialGrants, "attach" | "detach">,
): Promise<void> {
  app.post<{ Params: AppParams; Body: AttachCredentialBody }>(
    "/artifacts/:appId/credentials",
    {
      schema: {
        summary: "Give an app a generic credential",
        description:
          "Gives one of your dynamic apps a generic credential you added, as the named environment variable of its backend, and restarts it. The app's code can read the value. Apps' own tokens can't attach credentials.",
        params: appParams,
        body: attachCredentialBody,
        response: { 200: appCredentialListResponse },
      },
    },
    async (request) =>
      grants.attach(keyActor(request), request.params.appId, request.body),
  );
  app.delete<{ Params: AppCredentialParams }>(
    "/artifacts/:appId/credentials/:env",
    {
      schema: {
        summary: "Remove a credential from an app",
        description:
          "Removes the credential the app receives as this variable and restarts the app without it. The credential shows as removing until the old process has stopped.",
        params: appCredentialParams,
        response: { 200: appCredentialListResponse },
      },
    },
    async (request) =>
      grants.detach(
        keyActor(request),
        request.params.appId,
        request.params.env,
      ),
  );
}
