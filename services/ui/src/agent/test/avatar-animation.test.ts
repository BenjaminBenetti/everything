import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { agentAvatarIds } from "@everything/agent-contracts/avatar";
import { AvatarAnimationRegistry } from "../service/avatar-animation-registry.js";
import { avatarIdleEyes } from "../model/avatar-idle-eyes.js";
import {
  avatarThinkingArtwork,
  avatarThinkingPaw,
  avatarThinkingPawSize,
} from "../model/avatar-thinking-pose.js";
import {
  avatarWatchingGlass,
  avatarWatchingLensRadius,
  avatarWatchingLids,
  avatarWatchingReach,
} from "../model/avatar-watching-pose.js";

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
  registry.register("wave", Wave, Blink);
  assert.equal(registry.get("idle"), Blink);
  assert.equal(registry.get("wave"), Wave);
  assert.equal(registry.get("unavailable"), undefined);
  assert.equal(registry.getStill("wave"), Blink);
  assert.equal(registry.getStill("idle"), undefined);
  assert.equal(registry.getStill("unavailable"), undefined);
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

test("every thinking paw rests inside the artwork, below the moved eyes", () => {
  const { scale, shift } = avatarThinkingArtwork;
  for (const id of agentAvatarIds) {
    const paw = avatarThinkingPaw(id);
    assert.ok(Number.isInteger(paw.x) && Number.isInteger(paw.y), id);
    assert.ok(paw.x >= 0 && paw.x + avatarThinkingPawSize <= 128, id);
    assert.ok(paw.y >= 0 && paw.y + avatarThinkingPawSize <= 128, id);
    const eyesBottom = Math.max(
      ...avatarIdleEyes[id].map((eye) => eye.y + eye.height),
    );
    assert.ok(paw.y > 64 + (eyesBottom - 64) * scale + (shift / 100) * 128, id);
  }
});

test("the stylesheet moves thinking artwork exactly where the paw expects it", () => {
  const { scale, shift } = avatarThinkingArtwork;
  const css = readFileSync(
    new URL("../style/avatar-animation.css", import.meta.url),
    "utf8",
  );
  const rule = css.match(
    /\[data-avatar-animation="thinking"\]\) > img \{\s*transform: ([^;]+);/,
  );
  assert.equal(rule?.[1], `translate(-${shift}%, ${shift}%) scale(${scale})`);
});

test("every watching glass and its paw stay inside the artwork, clear of the eyes", () => {
  for (const id of agentAvatarIds) {
    const glass = avatarWatchingGlass(id);
    assert.ok(Number.isInteger(glass.x) && Number.isInteger(glass.y), id);
    assert.ok(glass.x - avatarWatchingLensRadius >= 0, id);
    assert.ok(glass.y - avatarWatchingLensRadius >= 0, id);
    assert.ok(glass.x + avatarWatchingReach <= 128, id);
    assert.ok(glass.y + avatarWatchingReach <= 128, id);
    for (const eye of avatarIdleEyes[id]) {
      // The nearest point of the eye's rectangle lies outside the lens.
      const nearestX = Math.max(eye.x, Math.min(glass.x, eye.x + eye.width));
      const nearestY = Math.max(eye.y, Math.min(glass.y, eye.y + eye.height));
      assert.ok(
        Math.hypot(glass.x - nearestX, glass.y - nearestY) >
          avatarWatchingLensRadius,
        id,
      );
    }
  }
});

test("watching lids cover only the upper half of each eye, in its own face colour", () => {
  for (const id of agentAvatarIds) {
    const eyes = avatarIdleEyes[id];
    const lids = avatarWatchingLids(id);
    assert.equal(lids.length, eyes.length, id);
    lids.forEach((lid, index) => {
      const eye = eyes[index]!;
      assert.deepEqual(
        { x: lid.x, y: lid.y, width: lid.width, lid: lid.lid },
        { x: eye.x, y: eye.y, width: eye.width, lid: eye.lid },
        id,
      );
      assert.ok(lid.height >= eye.height / 2 && lid.height < eye.height, id);
    });
  }
});
