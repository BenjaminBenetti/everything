import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  V1TokenReview,
  V1TokenReviewStatus,
} from "@kubernetes/client-node";
import { KubernetesTokenVerifier } from "../adapter/kubernetes-token-verifier.js";

const policy = {
  audience: "everything-upgrader",
  username: "system:serviceaccount:everything:everything",
};

/** A verifier whose TokenReview answers with the given status, recording the reviewed spec. */
function verifier(status: V1TokenReviewStatus) {
  const reviews: V1TokenReview[] = [];
  return {
    reviews,
    verifier: new KubernetesTokenVerifier(
      {
        createTokenReview: async ({ body }: { body: V1TokenReview }) => {
          reviews.push(body);
          return { ...body, status };
        },
      } as never,
      policy,
    ),
  };
}

test("accepts the allowed account's token for this audience", async () => {
  const { verifier: accepting, reviews } = verifier({
    authenticated: true,
    user: { username: policy.username },
    audiences: [policy.audience],
  });
  assert.deepEqual(await accepting.verify("token"), {
    subject: policy.username,
  });
  assert.deepEqual(reviews[0]!.spec, {
    token: "token",
    audiences: [policy.audience],
  });
});

test("rejects unauthenticated tokens, other accounts, and other audiences", async () => {
  for (const status of [
    { authenticated: false },
    {
      authenticated: true,
      user: { username: "system:serviceaccount:everything:artifact" },
      audiences: [policy.audience],
    },
    {
      authenticated: true,
      user: { username: "system:serviceaccount:other:everything" },
      audiences: [policy.audience],
    },
    {
      authenticated: true,
      user: { username: policy.username },
      audiences: ["https://kubernetes.default.svc"],
    },
    { authenticated: true, user: { username: policy.username } },
  ])
    await assert.rejects(
      verifier(status).verifier.verify("token"),
      JSON.stringify(status),
    );
});
