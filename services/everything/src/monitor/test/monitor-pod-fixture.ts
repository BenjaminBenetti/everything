import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  MonitorInput,
  MonitorResult,
} from "@everything/workspace-contracts/monitor";

/** The kernel's flag for a process that has begun exiting, in `/proc/<pid>/stat`. */
const exitingFlag = 0x4;

/**
 * Report whether a process group has a member that is neither a zombie nor already exiting. A killed
 * command's forked children can outlive its reaped leader as zombies until PID 1 reaps them, and
 * `kill(-pgid, 0)` still finds those. Without `/proc`, any member counts.
 */
function liveGroup(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch {
    return false;
  }
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
  } catch {
    return true;
  }
  return pids.some((pid) => {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return false;
    }
    // Fields after the parenthesised command name: state, ppid, pgrp, session, tty, tpgid, flags.
    const [state, , pgrp, , , , flags] = stat
      .slice(stat.lastIndexOf(")") + 2)
      .split(" ");
    return (
      Number(pgrp) === pgid &&
      state !== "Z" &&
      state !== "X" &&
      (Number(flags) & exitingFlag) === 0
    );
  });
}

/** A real background process tracked by the fixture pod. */
interface FixtureMonitor {
  result: MonitorResult;
  readonly child: ChildProcess;
  readonly done: Promise<void>;
}

/**
 * A local stand-in for a teammate pod's monitor API that runs real Bash processes, so Everything's
 * HTTP transport, following, and delivery are exercised end to end without a cluster.
 */
export async function monitorPodFixture(directory: string) {
  const monitors = new Map<string, FixtureMonitor>();
  const requests: string[] = [];
  let unavailable = 0;
  let cancelFailures = 0;
  let terminalWaits = 0;
  let heldCancel: Promise<boolean> | undefined;
  let heldStart: Promise<void> | undefined;

  /** Parse a JSON request body. */
  async function body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  /** Spawn a detached Bash process group whose output is retained. */
  function start(input: MonitorInput): MonitorResult {
    const id = randomUUID();
    const child = spawn("bash", ["-c", input.command], {
      cwd: directory,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => chunks.push(chunk));
    const result: MonitorResult = {
      id,
      status: "running",
      exitCode: null,
      signal: null,
      output: "",
      outputBytes: 0,
      truncated: false,
      log: `.monitors/${id}.log`,
      logTruncated: false,
      reason: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    const done = new Promise<void>((resolve) =>
      child.once("close", (exitCode, signal) => {
        const monitor = monitors.get(id);
        const output = Buffer.concat(chunks);
        if (monitor && monitor.result.status === "running")
          monitor.result = {
            ...monitor.result,
            status: monitor.result.reason ? "cancelled" : "exited",
            exitCode,
            signal,
            output: output.toString("utf8"),
            outputBytes: output.length,
            finishedAt: new Date().toISOString(),
          };
        resolve();
      }),
    );
    monitors.set(id, { result, child, done });
    return result;
  }

  const server = createServer((request, response) => {
    void (async () => {
      const route = request.url ?? "";
      requests.push(route);
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const input = await body(request);
      if (route === "/monitors") {
        if (heldStart) {
          await heldStart;
          heldStart = undefined;
        }
        return reply(200, start(input as MonitorInput));
      }
      const [, , id, action] = route.split("/");
      const monitor = monitors.get(id ?? "");
      if (action === "wait" && unavailable > 0) {
        unavailable--;
        return reply(503, { code: "UNAVAILABLE", message: "restarting" });
      }
      if (action === "cancel" && heldCancel) {
        const fail = await heldCancel;
        heldCancel = undefined;
        if (fail)
          return reply(503, { code: "UNAVAILABLE", message: "restarting" });
      }
      if (action === "cancel" && cancelFailures > 0) {
        cancelFailures--;
        return reply(503, { code: "UNAVAILABLE", message: "restarting" });
      }
      if (!monitor) return reply(404, { code: "MONITOR_NOT_FOUND" });
      if (action === "cancel" && monitor.result.status === "running") {
        monitor.result = { ...monitor.result, reason: "Stopped on request." };
        process.kill(-monitor.child.pid!, "SIGKILL");
      }
      if (action === "cancel" || action === "wait")
        await Promise.race([
          monitor.done,
          new Promise((resolve) =>
            setTimeout(resolve, action === "wait" ? 200 : 5000),
          ),
        ]);
      if (action === "wait" && monitor.result.status !== "running")
        terminalWaits++;
      return reply(200, monitor.result);
    })();
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    requests,
    /** Route the cluster Service URL Everything builds to this local server. */
    fetcher: ((url: string | URL | Request, init?: RequestInit) =>
      fetch(
        String(url).replace(/^http:\/\/[^/]+/, base),
        init,
      )) as typeof fetch,
    /** Report whether a monitor's process group still has a live process. */
    running(id: string): boolean {
      const pid = monitors.get(id)?.child.pid;
      return pid ? liveGroup(pid) : false;
    },
    /** Report whether any started process group still has a live process. */
    anyRunning(): boolean {
      return [...monitors.keys()].some((id) => this.running(id));
    },
    /** Answer the next `count` cancel requests with a server error. */
    failCancels(count: number): void {
      cancelFailures = count;
    },
    /** Hold the next cancel request until released, then answer it with a server error or as usual. */
    holdCancel(): (fail: boolean) => void {
      let release!: (fail: boolean) => void;
      heldCancel = new Promise((resolve) => (release = resolve));
      return release;
    },
    /** Hold the next start request until released, then start the command as usual. */
    holdStart(): () => void {
      let release!: () => void;
      heldStart = new Promise((resolve) => (release = resolve));
      return release;
    },
    /** Count wait requests answered with a finished command. */
    terminalWaits(): number {
      return terminalWaits;
    },
    /** Answer the next `count` wait requests with a server error. */
    failWaits(count: number): void {
      unavailable = count;
    },
    /** Forget every monitor, as a restarted pod would, after killing its process. */
    restart(): void {
      for (const monitor of monitors.values())
        if (
          monitor.child.exitCode === null &&
          monitor.child.signalCode === null
        )
          process.kill(-monitor.child.pid!, "SIGKILL");
      monitors.clear();
    },
    /** Kill remaining processes and stop the server. */
    async close(): Promise<void> {
      this.restart();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
