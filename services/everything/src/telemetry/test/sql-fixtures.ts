import type { TelemetryRow } from "../interface/telemetry-search.js";

/**
 * The groups that satisfy a `HAVING` clause of `column = 'literal'` and `column IN (...)`
 * conditions on grouped columns, joined by AND, as SQL applies it: to whole groups, after grouping
 * and before ordering and `LIMIT`. Any other condition is refused, so a query the fake can't answer
 * faithfully fails instead of passing.
 */
export function having(groups: TelemetryRow[], clause: string | undefined) {
  if (!clause) return groups;
  const conditions = clause.split(" AND ").map((condition) => {
    const equal = /^(\w+) = '((?:[^']|'')*)'$/.exec(condition);
    if (equal)
      return (group: TelemetryRow) =>
        group[equal[1]!] === equal[2]!.replaceAll("''", "'");
    const among = /^(\w+) IN \((.*)\)$/.exec(condition);
    if (among) {
      const values = [...among[2]!.matchAll(/'((?:[^']|'')*)'/g)].map(
        (literal) => literal[1]!.replaceAll("''", "'"),
      );
      return (group: TelemetryRow) => values.includes(String(group[among[1]!]));
    }
    throw new Error(`The fake backend can't answer HAVING ${condition}`);
  });
  return groups.filter((group) =>
    conditions.every((condition) => condition(group)),
  );
}
