/** Folder in a worker where each delegated task's completion receipt is written, by task ID. */
export const taskReceiptDirectory = "/tmp/everything-tasks";

/** Placeholders a teammate replaces in the receipt monitor script. */
export const taskReceiptPlaceholders = {
  target: "FLEET/INSTANCE",
  task: "TASK_ID",
} as const;

/**
 * The worker-side probe of a receipt: print it, or `missing` only when it doesn't exist yet, meaning
 * the nearest existing folder on its path can be searched and so would show it. A receipt that
 * exists but can't be read, such as a folder or a file without read permission, or a path through a
 * file or a folder that can't be searched, fails with the reason instead of passing for missing. It
 * runs in single quotes, so it has none of its own.
 */
export const taskReceiptProbe = `f=$1; while ! [ -e "$f" ]; do f=\${f%/*}; f=\${f:-/}; done; if [ "$f" = "$1" ]; then cat -- "$1"; elif [ -d "$f" ] && [ -x "$f" ]; then echo missing; else echo "cannot search $f for the receipt" >&2; exit 1; fi`;

/**
 * A monitor script that waits for a worker's receipt with short `fleet shell` probes and ordinary
 * sleeps, so no model turn is spent polling. It ignores a missing, partial, or stale receipt, prints
 * the receipt and exits 0 when the task succeeded or 1 when it failed, and exits 2 when probes keep
 * failing, whether Fleet can't reach the worker or the receipt can't be read there. Over the gateway, `fleet exec` runs on the caller's pod, so probes use `fleet shell`,
 * whose output passes through a terminal and whose failures all exit non-zero. Each probe has its own
 * deadline, since a stalled stream would otherwise hold the loop until the monitor's timeout, and
 * the client's own messages go to a separate file so they can never be mistaken for the receipt.
 */
export const taskReceiptMonitorScript = `target=${taskReceiptPlaceholders.target} task=${taskReceiptPlaceholders.task} interval=30
receipt=${taskReceiptDirectory}/$task/done.json failures=0 errors=$(mktemp)
trap 'rm -f "$errors"' EXIT
while :; do
  if out=$(timeout 60 fleet shell "$target" -- sh -c '${taskReceiptProbe}' sh "$receipt" </dev/null 2>"$errors"); then
    failures=0 out=$(printf '%s' "$out" | tr -d '\\r')
    if [ "$out" != missing ]; then
      if printf '%s' "$out" | jq -e --arg task "$task" '.task == $task and (.status == "succeeded" or .status == "failed")' >/dev/null 2>&1; then
        printf '%s\\n' "$out"; [ "$(printf '%s' "$out" | jq -r .status)" = succeeded ]; exit
      fi
      echo "Ignoring an unfinished or stale receipt: $out"
    fi
  elif [ $((failures += 1)) -ge 10 ]; then
    echo "Could not check $receipt in $target: $(head -c 2000 "$errors")$(printf '%s' "$out" | tr -d '\\r' | head -c 2000)"; exit 2
  fi
  sleep "$interval"
done`;
