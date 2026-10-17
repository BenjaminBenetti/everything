import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CommandFailure } from "../interface/command-runner.js";
import { HelmUpgrade, helmError } from "../service/helm-upgrade.js";

const release = {
  chart: "oci://ghcr.io/owner/everything/charts/everything",
  plainHttp: false,
  name: "everything",
  namespace: "everything",
  settingsFile: "/settings/values.yaml",
};

/** A Helm stand-in that unpacks a chart, optionally without production values, and records calls. */
function fakeHelm(
  options: { productionValues?: boolean; failUpgrade?: string } = {},
) {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      run: async (program: string, args: readonly string[]) => {
        assert.equal(program, "helm");
        calls.push([...args]);
        if (args[0] === "pull") {
          const chart = path.join(
            args[args.indexOf("--untardir") + 1]!,
            "everything",
          );
          await mkdir(chart);
          if (options.productionValues !== false)
            await writeFile(
              path.join(chart, "values.prod.yaml"),
              "global: {}\n",
            );
        }
        if (args[0] === "upgrade" && options.failUpgrade)
          throw new CommandFailure("helm", options.failUpgrade);
      },
    },
  };
}

test("installs the new chart with its production values under the installer's settings, as the installer does", async (context) => {
  const work = await mkdtemp(path.join(tmpdir(), "helm-upgrade-"));
  context.after(() => rm(work, { recursive: true, force: true }));
  const helm = fakeHelm();
  await new HelmUpgrade(release, helm.runner, work).install("0.2.0");
  const [pull, upgrade] = helm.calls;
  assert.deepEqual(pull!.slice(0, 5), [
    "pull",
    release.chart,
    "--version",
    "0.2.0",
    "--untar",
  ]);
  assert.ok(!pull!.includes("--plain-http"));
  const chart = upgrade![2]!;
  assert.deepEqual(upgrade, [
    "upgrade",
    "everything",
    chart,
    "--namespace",
    "everything",
    "--reset-values",
    "--values",
    path.join(chart, "values.prod.yaml"),
    "--values",
    "/settings/values.yaml",
    "--set-file",
    "upgrades.settings=/settings/values.yaml",
    "--rollback-on-failure",
    "--wait",
    "--timeout",
    "15m",
  ]);
});

test("explains failures with Helm's error lines, or the end of its output", async (context) => {
  const work = await mkdtemp(path.join(tmpdir(), "helm-upgrade-"));
  context.after(() => rm(work, { recursive: true, force: true }));
  await assert.rejects(
    new HelmUpgrade(
      release,
      fakeHelm({
        failUpgrade:
          "coalesce.go:298: warning\nError: UPGRADE FAILED: release everything failed, and has been rolled back\n",
      }).runner,
      work,
    ).install("0.2.0"),
    {
      name: "UpgradeFailure",
      message:
        "Error: UPGRADE FAILED: release everything failed, and has been rolled back",
    },
  );
  await assert.rejects(
    new HelmUpgrade(
      release,
      fakeHelm({ productionValues: false }).runner,
      work,
    ).install("0.2.0"),
    /no values.prod.yaml/,
  );
  assert.equal(helmError("one\ntwo\n"), "one\ntwo");
  assert.equal(helmError(""), "Helm stopped without explaining why.");
});
