import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { FileSnapshot } from "./fleet-stack-fixture.js";

const privileged = process.getuid?.() === 0;

/** A Fleet home's token, settings, and gateway session in a temporary folder, removed after the test. */
async function files(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "fleet-snapshot-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return {
    token: path.join(directory, "mcp.token"),
    config: path.join(directory, "config.json"),
    session: path.join(directory, "gateway_session.json"),
  };
}

test("the e2e stack puts a borrowed Fleet home's token, settings, and gateway session back byte for byte", async (context) => {
  const { token, config, session } = await files(context);
  await writeFile(token, "existing-token\n", { mode: 0o600 });
  await writeFile(session, '{"session_token":"original-resume-jwt"}', {
    mode: 0o640,
  });
  const snapshot = new FileSnapshot();
  await snapshot.take([token, config, session]);
  // The stack registers a new session and writes settings that did not exist.
  await writeFile(session, '{"session_token":"test-gateway-jwt"}');
  await rm(token);
  await writeFile(token, "minted");
  await writeFile(config, "{}");
  await snapshot.restore();
  assert.equal(await readFile(token, "utf8"), "existing-token\n");
  assert.equal(
    await readFile(session, "utf8"),
    '{"session_token":"original-resume-jwt"}',
  );
  assert.equal((await stat(token)).mode & 0o777, 0o600);
  assert.equal((await stat(session)).mode & 0o777, 0o640);
  await assert.rejects(stat(config), { code: "ENOENT" });
});

test(
  "the e2e stack refuses a Fleet home it can't read and then leaves it as it was",
  { skip: privileged && "root reads files whatever their permissions" },
  async (context) => {
    const { token, config, session } = await files(context);
    await writeFile(token, "existing-token");
    await writeFile(session, "original-session");
    await chmod(session, 0o000);
    const snapshot = new FileSnapshot();
    await assert.rejects(snapshot.take([token, config, session]), {
      code: "EACCES",
    });
    // The stack's cleanup runs anyway, and must neither delete nor rewrite anything.
    const before = await stat(token);
    await snapshot.restore();
    await chmod(session, 0o600);
    assert.equal(await readFile(session, "utf8"), "original-session");
    assert.equal(await readFile(token, "utf8"), "existing-token");
    assert.equal((await stat(token)).mtimeMs, before.mtimeMs);
    await assert.rejects(stat(config), { code: "ENOENT" });
  },
);
