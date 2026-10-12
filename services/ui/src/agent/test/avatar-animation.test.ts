import assert from "node:assert/strict";
import { test } from "node:test";
import { agentAvatarIds } from "@everything/agent-contracts/avatar";
import { AvatarAnimationRegistry } from "../service/avatar-animation-registry.js";
import { avatarIdleEyes } from "../model/avatar-idle-eyes.js";

/** Stand in for an independently implemented animation. */
function Blink() {
  return null;
}

/** A second effect confirms that registration does not depend on built-in names. */
function Wave() {
  return null;
}

test("animation registration supports independent effects and optional unknown names", () => {
  const registry = new AvatarAnimationRegistry();
  registry.register("idle", Blink);
  registry.register("wave", Wave);
  assert.equal(registry.get("idle"), Blink);
  assert.equal(registry.get("wave"), Wave);
  assert.equal(registry.get("unavailable"), undefined);
});

test("invalid registration cannot replace an existing effect", () => {
  const registry = new AvatarAnimationRegistry();
  registry.register("idle", Blink);
  assert.throws(() => registry.register("idle", Wave), /unique/);
  assert.throws(() => registry.register(" ", Wave), /nonempty/);
  assert.equal(registry.get("idle"), Blink);
});

test("every bundled character has eye regions inside its original artwork", () => {
  assert.deepEqual(Object.keys(avatarIdleEyes), [...agentAvatarIds]);
  for (const id of agentAvatarIds) {
    const eyes = avatarIdleEyes[id];
    assert.ok(eyes.length >= 1 && eyes.length <= 2, id);
    for (const eye of eyes) {
      assert.ok(eye.x >= 0 && eye.y >= 0, id);
      assert.ok(eye.width > 2 && eye.height > 2, id);
      assert.ok(eye.x + eye.width <= 128, id);
      assert.ok(eye.y + eye.height <= 128, id);
      assert.match(eye.lid, /^#[0-9a-f]{6}$/i);
    }
  }
});
