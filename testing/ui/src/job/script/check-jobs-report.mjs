// Fail unless a Playwright JSON report shows exactly the jobs harness's desktop and phone tests,
// each passed on its only attempt, with nothing skipped, flaky, or erroring. Counts come from the
// report itself, never from the job's conclusion. Writes a small summary beside the report.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The harness's tests: one per project, identified by project and title tag. */
const expectedTests = [
  { project: "desktop", tag: "@desktop" },
  { project: "phone", tag: "@phone" },
];

const file = process.argv[2];
if (!file) throw new Error("Usage: check-jobs-report.mjs <report.json>");
const report = JSON.parse(readFileSync(file, "utf8"));

/** Every test in the report, with its project, title, overall status, and each attempt's result. */
const tests = [];
function collect(suite) {
  for (const spec of suite.specs ?? [])
    for (const test of spec.tests ?? [])
      tests.push({
        project: test.projectName,
        title: spec.title,
        status: test.status,
        results: (test.results ?? []).map((result) => result.status),
        durationMs: (test.results ?? []).reduce(
          (total, result) => total + (result.duration ?? 0),
          0,
        ),
      });
  for (const child of suite.suites ?? []) collect(child);
}
for (const suite of report.suites ?? []) collect(suite);

const stats = report.stats ?? {};
const problems = [];
if ((report.errors ?? []).length)
  problems.push(`${report.errors.length} top-level errors`);
for (const [key, value] of Object.entries({
  expected: expectedTests.length,
  unexpected: 0,
  flaky: 0,
  skipped: 0,
}))
  if (stats[key] !== value)
    problems.push(`stats.${key} is ${stats[key]}, expected ${value}`);
if (tests.length !== expectedTests.length)
  problems.push(`${tests.length} tests, expected ${expectedTests.length}`);
for (const { project, tag } of expectedTests) {
  const matches = tests.filter(
    (test) => test.project === project && test.title.startsWith(tag),
  );
  if (matches.length !== 1)
    problems.push(`${matches.length} ${project} tests tagged ${tag}`);
  else if (
    matches[0].status !== "expected" ||
    matches[0].results.join() !== "passed"
  )
    problems.push(
      `${project}: status ${matches[0].status}, results ${matches[0].results.join() || "none"}`,
    );
}

const summary = {
  passed: problems.length === 0,
  stats: {
    expected: stats.expected,
    unexpected: stats.unexpected,
    flaky: stats.flaky,
    skipped: stats.skipped,
    durationMs: stats.duration,
  },
  topLevelErrors: (report.errors ?? []).length,
  tests,
  problems,
};
writeFileSync(
  path.join(path.dirname(file), "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
if (problems.length) process.exit(1);
