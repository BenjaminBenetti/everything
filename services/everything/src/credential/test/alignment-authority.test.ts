import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ArtifactDetails } from "@everything/artifact-contracts";
import type {
  AppCredentialAttachment,
  AppCredentialGrant,
} from "@everything/artifact-contracts/credential";
import { SessionCipher } from "@everything/security/session-cipher";
import { ArtifactRequestFailure } from "../../artifact/error/artifact-errors.js";
import { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import type { GenericCredentialRepository } from "../../key/interface/generic-credential-repository.js";
import type { StoredKey } from "../../key/model/stored-key.js";
import { CredentialGrants } from "../service/credential-grants.js";

// A grant is authorized against the app's credential generation read when the request starts. A
// refusal because apps hold another value is aligned and retried, and that retry must carry the
// same authority: a removal that completes while alignment runs refuses it, and only a new
// request can grant the credential again. The app service is emulated with its grant rules.

const cipher = new SessionCipher(Buffer.alloc(32, 5).toString("base64"));
const ownerId = "owner";
const appId = "7d1e4c2a-5b3f-4a6e-8c9d-0f1a2b3c4d5e";
const context = {
  ownerId,
  author: { id: "agent", name: "Ada" },
  workspace: "/workspace/agent",
  shared: "/workspace/shared",
  privateDirectory: "/workspace/agent/.pi",
};

/** One grant as the app service keeps it. */
interface Held {
  readonly credentialId: string;
  readonly env: string;
  readonly version: number;
  readonly valueId: string;
}

/** A refusal as the app service answers it. */
function refusal(code: string): ArtifactRequestFailure {
  return new ArtifactRequestFailure(409, code, "Refused.");
}

/**
 * One app in the app service: its grants, its credential generation, which every grant change
 * advances, and the value recorded for each credential. Additions must carry the current
 * generation, and a second value at a recorded version is refused, as in `changeGrants`.
 */
class AppService {
  generation = 3;
  release = 5;
  grants: Held[] = [];
  readonly records = new Map<string, { version: number; valueId: string }>();
  readonly sentGenerations: (number | undefined)[] = [];
  reads = 0;

  details(): ArtifactDetails {
    return {
      id: appId,
      slug: "bot",
      release: this.release,
      credentialGeneration: this.generation,
      credentials: this.grants.map((grant) => ({
        ...grant,
        name: null,
        status: "applied",
      })),
    } as unknown as ArtifactDetails;
  }

  /** Replace the grants, checking additions as the app service's repository does. */
  change(bindings: readonly Held[], expectedGeneration?: number): void {
    const same = (a: Held, b: Held) =>
      a.credentialId === b.credentialId &&
      a.env === b.env &&
      a.version === b.version &&
      a.valueId === b.valueId;
    const added = bindings.filter(
      (binding) => !this.grants.some((held) => same(held, binding)),
    );
    const removed = this.grants.filter(
      (held) => !bindings.some((binding) => same(held, binding)),
    );
    if (added.length && expectedGeneration !== this.generation)
      throw refusal("CREDENTIAL_GRANTS_CHANGED");
    for (const binding of added) {
      const record = this.records.get(binding.credentialId);
      if (record && record.version > binding.version)
        throw refusal("CREDENTIAL_CHANGED");
      if (
        record &&
        record.version === binding.version &&
        record.valueId !== binding.valueId
      )
        throw refusal("CREDENTIAL_VALUE_CONFLICT");
    }
    for (const binding of added)
      this.records.set(binding.credentialId, {
        version: binding.version,
        valueId: binding.valueId,
      });
    if (!added.length && !removed.length) return;
    this.grants = bindings.map((binding) => ({ ...binding }));
    this.generation += 1;
  }

  /** Store a delivered value and raise grants to it; deliveries never change the generation. */
  deliver(credentialId: string, version: number, valueId: string): void {
    const record = this.records.get(credentialId);
    if (record && record.version > version)
      throw refusal("CREDENTIAL_SUPERSEDED");
    if (record?.version === version && record.valueId !== valueId)
      throw refusal("CREDENTIAL_VALUE_CONFLICT");
    this.records.set(credentialId, { version, valueId });
    this.grants = this.grants.map((grant) =>
      grant.credentialId === credentialId && grant.version < version
        ? { ...grant, version, valueId }
        : grant,
    );
  }

  /** Remove a credential from the app; removals need no generation. */
  detach(env: string): void {
    this.change(this.grants.filter((grant) => grant.env !== env));
  }

  /** The gateway Everything uses, answering only for this app. */
  gateway() {
    const service = this;
    const app = (reference: string) => {
      if (reference !== appId && reference !== "bot")
        throw new ArtifactRequestFailure(404, "ARTIFACT_NOT_FOUND", "None.");
    };
    const held = ({ credentialId, env, version, valueId }: Held): Held => ({
      credentialId,
      env,
      version,
      valueId,
    });
    return {
      async get(_owner: string, reference: string) {
        app(reference);
        service.reads += 1;
        return service.details();
      },
      async deploy(
        _actor: unknown,
        reference: string,
        input: {
          credentials?: AppCredentialGrant[];
          credentialGeneration?: number;
          basedOn?: number;
        },
      ) {
        app(reference);
        service.sentGenerations.push(input.credentialGeneration);
        if (input.basedOn !== undefined && input.basedOn !== service.release)
          throw refusal("RELEASE_CONFLICT");
        service.change(
          input.credentials?.map(held) ?? service.grants,
          input.credentialGeneration,
        );
        service.release += 1;
        return service.details();
      },
      async attachCredential(
        _actor: unknown,
        reference: string,
        grant: AppCredentialAttachment,
      ) {
        app(reference);
        service.sentGenerations.push(grant.credentialGeneration);
        if (service.grants.some((held) => held.env === grant.env))
          throw refusal("CREDENTIAL_VARIABLE_TAKEN");
        service.change(
          [...service.grants, held(grant)],
          grant.credentialGeneration,
        );
        return service.details();
      },
      async detachCredential(_actor: unknown, reference: string, env: string) {
        app(reference);
        service.detach(env);
        return service.details();
      },
      async credentialUses() {
        return [];
      },
    };
  }
}

/**
 * Everything's side: the owner's credentials, and alignment that saves the value past the version
 * apps hold and delivers it, as `CredentialRollouts.align` does. `during` runs while alignment is
 * paused, before it delivers, to let another request finish in between.
 */
async function world(options: { held: boolean }) {
  const service = new AppService();
  const records: StoredKey[] = [];
  /** Add a credential of the owner. */
  const add = async (name: string, version: number) => {
    const record: StoredKey = {
      id: randomUUID(),
      ownerId,
      name,
      type: "generic",
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
      encryptedMaterial: await cipher.seal(`aa-sentinel-${name}-${version}`),
      description: null,
      version,
      valueId: randomUUID(),
      deletedAt: null,
    };
    records.push(record);
    return record;
  };
  // Apps hold version 2 of the credential with one value; Everything was restored to version 2
  // with another, so the first grant is refused as a value conflict.
  const slack = await add("slack", 2);
  const runtimeValue = randomUUID();
  service.records.set(slack.id, { version: 2, valueId: runtimeValue });
  if (options.held)
    service.grants = [
      {
        credentialId: slack.id,
        env: "TOKEN",
        version: 2,
        valueId: runtimeValue,
      },
    ];
  const repository: Pick<
    GenericCredentialRepository,
    "findByName" | "getById" | "list"
  > = {
    async findByName(scope, name) {
      return records.filter(
        (record) =>
          record.ownerId === scope.ownerId &&
          !record.deletedAt &&
          record.name.toLowerCase() === name.toLowerCase(),
      );
    },
    async getById(scope, id) {
      return records.find(
        (record) =>
          record.id === id &&
          (scope.usage === "credential-sync" ||
            (record.ownerId === scope.ownerId && !record.deletedAt)),
      );
    },
    async list() {
      return records;
    },
  };
  const hooks: { during?: (() => Promise<void> | void) | undefined } = {};
  const aligned: string[] = [];
  const aligner = {
    async align(id: string) {
      aligned.push(id);
      await hooks.during?.();
      const record = records.find((candidate) => candidate.id === id)!;
      const runtime = service.records.get(id);
      const index = records.indexOf(record);
      const version = Math.max(record.version, runtime?.version ?? 0) + 1;
      records[index] = { ...record, version, valueId: randomUUID() };
      service.deliver(id, version, records[index]!.valueId!);
    },
  };
  const gateway = service.gateway();
  const grants = new CredentialGrants(repository, cipher, gateway, aligner);
  const workbench = new ArtifactWorkbench(
    gateway as unknown as ConstructorParameters<typeof ArtifactWorkbench>[0],
    grants,
  );
  return { add, aligned, grants, hooks, records, service, slack, workbench };
}

for (const basedOn of [undefined, 5] as const)
  test(`a teammate's deploy whose credential is removed during alignment isn't granted it again by the retry (${basedOn === undefined ? "without" : "with"} basedOn)`, async () => {
    const { aligned, hooks, service, slack, workbench } = await world({
      held: true,
    });
    const request = {
      credentials: [{ name: "slack", env: "TOKEN" }],
      ...(basedOn === undefined ? {} : { basedOn }),
    };
    // The user removes it while the teammate's request waits on alignment.
    hooks.during = () => service.detach("TOKEN");
    await assert.rejects(workbench.deploy(context, "bot", request), {
      code: "CREDENTIAL_GRANTS_CHANGED",
    });
    assert.deepEqual(aligned, [slack.id]);
    assert.deepEqual(service.grants, [], "the removal stands");
    assert.equal(service.reads, 1, "authority is read once per request");
    assert.deepEqual(service.sentGenerations, [3, 3]);
    assert.equal(service.generation, 4);

    // A new request after the removal is authorized afresh and grants it.
    hooks.during = undefined;
    const fresh = await workbench.deploy(context, "bot", {
      credentials: [{ name: "slack", env: "TOKEN" }],
      ...(basedOn === undefined ? {} : { basedOn: service.release }),
    });
    assert.deepEqual(
      fresh.credentials.map(({ credentialId, env }) => [credentialId, env]),
      [[slack.id, "TOKEN"]],
    );
    assert.equal(service.reads, 2);
  });

test("a browser attach whose credential is attached and removed during alignment isn't granted it again by the retry", async () => {
  const { aligned, grants, hooks, service, slack } = await world({
    held: false,
  });
  // Another request attaches it and the user then removes it while this one waits on alignment.
  hooks.during = () => {
    service.change(
      [
        ...service.grants,
        {
          ...service.records.get(slack.id)!,
          credentialId: slack.id,
          env: "TOKEN",
        },
      ],
      service.generation,
    );
    service.detach("TOKEN");
  };
  await assert.rejects(
    grants.attach({ subject: ownerId }, appId, {
      credentialId: slack.id,
      env: "TOKEN",
    }),
    { code: "CREDENTIAL_GRANTS_CHANGED" },
  );
  assert.deepEqual(aligned, [slack.id]);
  assert.deepEqual(service.grants, [], "the removal stands");
  assert.equal(service.reads, 1, "authority is read once per request");
  assert.deepEqual(service.sentGenerations, [3, 3]);
  assert.equal(service.generation, 5);

  // Attaching it again is a new request and is granted.
  hooks.during = undefined;
  const fresh = await grants.attach({ subject: ownerId }, appId, {
    credentialId: slack.id,
    env: "TOKEN",
  });
  assert.deepEqual(
    fresh.credentials.map(({ credentialId, env }) => [credentialId, env]),
    [[slack.id, "TOKEN"]],
  );
});

test("an alignment retry with no change in between still grants the aligned value, with the authority read first", async () => {
  for (const operation of ["deploy", "attach"] as const) {
    const { aligned, grants, records, service, slack, workbench } = await world(
      { held: false },
    );
    if (operation === "deploy")
      await workbench.deploy(context, "bot", {
        credentials: [{ name: "slack", env: "TOKEN" }],
      });
    else
      await grants.attach({ subject: ownerId }, appId, {
        credentialId: slack.id,
        env: "TOKEN",
      });
    const saved = records.find((record) => record.id === slack.id)!;
    assert.deepEqual(aligned, [slack.id], operation);
    assert.equal(service.reads, 1, operation);
    assert.deepEqual(service.sentGenerations, [3, 3], operation);
    assert.deepEqual(
      service.grants,
      [
        {
          credentialId: slack.id,
          env: "TOKEN",
          version: 3,
          valueId: saved.valueId,
        },
      ],
      `${operation}: the aligned value is granted`,
    );
  }
});

test("a retry never switches to another credential that took the name of the one first resolved", async () => {
  const { add, hooks, records, service, slack, workbench } = await world({
    held: false,
  });
  // While alignment waits, the credential is deleted and another one is added under its name.
  hooks.during = async () => {
    const index = records.findIndex((record) => record.id === slack.id);
    records[index] = {
      ...records[index]!,
      encryptedMaterial: "",
      deletedAt: "2026-10-22T01:00:00.000Z",
    };
    await add("slack", 1);
  };
  await assert.rejects(
    workbench.deploy(context, "bot", {
      credentials: [{ name: "slack", env: "TOKEN" }],
    }),
    { code: "CREDENTIAL_NOT_FOUND" },
  );
  assert.deepEqual(service.grants, []);
  assert.equal(service.sentGenerations.length, 1);
});
