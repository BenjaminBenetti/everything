import assert from "node:assert/strict";
import { test } from "node:test";
import type { VoiceState } from "../model/composer-state.js";
import {
  spaceKeyDown,
  spaceKeyUp,
  type KeyFacts,
} from "../model/space-hold.js";

/** A plain keydown with optional overrides. */
function key(overrides: Partial<KeyFacts> = {}): KeyFacts {
  return {
    key: " ",
    repeat: false,
    isComposing: false,
    keyCode: 32,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

const idle: Pick<VoiceState, "phase" | "source"> = {
  phase: "idle",
  source: null,
};
const armed = { phase: "arming", source: "space" } as const;
const recording = { phase: "recording", source: "space" } as const;

test("an ordinary Space arms a hold and still types; repeats never type while armed", () => {
  assert.equal(spaceKeyDown(idle, key(), true), "arm");
  assert.equal(spaceKeyDown(armed, key({ repeat: true }), true), "suppress");
  assert.equal(spaceKeyUp(armed, " "), "disarm");
  // Holding is off on touch-only devices and when voice input is unavailable.
  assert.equal(spaceKeyDown(idle, key(), false), "none");
  // A repeat with no hold armed types normally.
  assert.equal(spaceKeyDown(idle, key({ repeat: true }), true), "none");
});

test("modifiers, IME composition, and processed IME keys never arm", () => {
  for (const overrides of [
    { shiftKey: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ])
    assert.equal(
      spaceKeyDown(idle, key(overrides), true),
      "none",
      JSON.stringify(overrides),
    );
});

test("any other key while armed ends the hold and keeps its own effect", () => {
  for (const other of ["a", "Enter", "Shift", "Backspace", "ArrowLeft", "Tab"])
    assert.equal(
      spaceKeyDown(armed, key({ key: other }), true),
      "disarm",
      other,
    );
  // A second, non-repeat Space press (such as fast typing) also ends the hold and types.
  assert.equal(spaceKeyDown(armed, key(), true), "disarm");
});

test("while recording, Space never types, Escape cancels, and other keys type normally", () => {
  assert.equal(
    spaceKeyDown(recording, key({ repeat: true }), true),
    "suppress",
  );
  assert.equal(spaceKeyDown(recording, key(), true), "suppress");
  assert.equal(
    spaceKeyDown(
      { phase: "starting", source: "space" },
      key({ repeat: true }),
      true,
    ),
    "suppress",
  );
  assert.equal(spaceKeyDown(recording, key({ key: "Escape" }), true), "cancel");
  // An IME composition's Escape belongs to the composition.
  assert.equal(
    spaceKeyDown(recording, key({ key: "Escape", isComposing: true }), true),
    "none",
  );
  assert.equal(spaceKeyDown(recording, key({ key: "x" }), true), "none");
  assert.equal(spaceKeyUp(recording, " "), "release");
  assert.equal(
    spaceKeyUp({ phase: "starting", source: "space" }, " "),
    "release",
  );
  assert.equal(spaceKeyUp(recording, "x"), "none");
});

test("a button recording or a pending transcript leaves Space typing alone", () => {
  const button = { phase: "recording", source: "button" } as const;
  assert.equal(spaceKeyDown(button, key(), true), "none");
  assert.equal(spaceKeyDown(button, key({ repeat: true }), true), "none");
  assert.equal(spaceKeyUp(button, " "), "none");
  const transcribing = { phase: "transcribing", source: "space" } as const;
  assert.equal(spaceKeyDown(transcribing, key(), true), "none");
  assert.equal(
    spaceKeyDown(transcribing, key({ key: "Escape" }), true),
    "cancel",
  );
  assert.equal(spaceKeyUp(transcribing, " "), "none");
  assert.equal(spaceKeyDown(idle, key({ key: "Escape" }), true), "none");
});

test("once a hold's dictation ends while Space is still down, its repeats still never type", () => {
  assert.equal(
    spaceKeyDown(idle, key({ repeat: true }), true, true),
    "suppress",
  );
  assert.equal(
    spaceKeyDown(idle, key({ repeat: true }), false, true),
    "suppress",
  );
  // A fresh press after release behaves normally.
  assert.equal(spaceKeyDown(idle, key(), true, false), "arm");
  assert.equal(spaceKeyDown(idle, key({ repeat: true }), true, false), "none");
});
