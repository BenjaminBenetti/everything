/** Folder in a worker where each delegated task's completion receipt is written, by task ID. */
export const taskReceiptDirectory = "/tmp/everything-tasks";

/** Placeholders a teammate replaces in the receipt monitor script. */
export const taskReceiptPlaceholders = {
  target: "FLEET/INSTANCE",
  task: "TASK_ID",
} as const;

/**
 * A monitor script that waits for a worker's receipt with short `fleet shell` probes and ordinary
 * sleeps, so no model turn is spent polling. It ignores a missing, partial, or stale receipt, prints
 * the receipt and exits 0 when the task succeeded or 1 when it failed, and exits 2 when Fleet stays
 * unreachable. Over the gateway, `fleet exec` runs on the caller's pod, so probes use `fleet shell`,
 * whose output passes through a terminal and whose failures all exit 1.
 */
export const taskReceiptMonitorScript = `target=${taskReceiptPlaceholders.target} task=${taskReceiptPlaceholders.task} interval=30
receipt=${taskReceiptDirectory}/$task/done.json failures=0
while :; do
  if out=$(fleet shell "$target" -- sh -c 'cat "$1" 2>/dev/null || echo missing' sh "$receipt" 2>&1); then
    failures=0 out=$(printf '%s' "$out" | tr -d '\\r')
    if [ "$out" != missing ]; then
      if printf '%s' "$out" | jq -e --arg task "$task" '.task == $task and (.status == "succeeded" or .status == "failed")' >/dev/null 2>&1; then
        printf '%s\\n' "$out"; [ "$(printf '%s' "$out" | jq -r .status)" = succeeded ]; exit
      fi
      echo "Ignoring an unfinished or stale receipt: $out"
    fi
  elif [ $((failures += 1)) -ge 10 ]; then
    echo "Fleet could not reach $target: $out"; exit 2
  fi
  sleep "$interval"
done`;
