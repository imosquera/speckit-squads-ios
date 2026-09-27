#!/usr/bin/env bun
// launchd entry point: run ONE unattended autopilot pass in <project-dir>.
// Invoked by the agent autopilot-schedule.ts installs; everything printed goes
// to the per-repo log the plist points at.
//   * Single-flight lock per project on this machine; `autopilot:claimed` (set by
//     the skill body, not here) serializes across machines.
//   * Keeps the RAW stream-json beside the decoded log (<slug>.raw.jsonl) so a
//     pass can be re-decoded later without re-running it.

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmdirSync, rmSync, statSync, writeSync } from "node:fs";
import { constants, homedir } from "node:os";
import { dirname, join } from "node:path";
import { slugFor } from "./autopilot-schedule.ts";

const DECODER = join(import.meta.dir, "stream-decode.ts");
const PREFLIGHT = join(import.meta.dir, "preflight-issues.ts");
const FETCH = join(import.meta.dir, "fetch-open-issues.ts");
const PARK = join(import.meta.dir, "park-issue.ts");
const BUN = process.execPath;
const RAW_MAX_BYTES = 64 * 1024 * 1024;
const TMP = process.env.TMPDIR || "/tmp";

const pad = (n: number) => String(n).padStart(2, "0");
function ts(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
// Synchronous, so our lines interleave correctly with the children's in the shared log.
const log = (msg: string) => writeSync(1, `${ts()} ${msg}\n`);
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

function rawLogFor(project: string): string {
  let root = "";
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: project, stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 0) root = r.stdout.toString().replace(/\n+$/, "");
  } catch { /* unreadable dir */ }
  return `${homedir()}/Library/Logs/speckit-autopilot/${slugFor(root || project)}.raw.jsonl`;
}

const PROJECT = process.argv[2];
if (!PROJECT) {
  process.stderr.write("usage: autopilot-run.ts <project-dir>\n");
  process.exit(1);
}
try {
  process.chdir(PROJECT);
} catch {
  log(`FATAL cannot cd into ${PROJECT}`);
  process.exit(1);
}

const lock = `${TMP}/speckit-autopilot-${sha1(PROJECT).slice(0, 8)}.lock`;
try {
  mkdirSync(lock);
} catch {
  log(`previous pass still active (${lock}) — skipping this tick`);
  process.exit(0);
}

let pickedIssue = "";
// Runs on every exit. Removing `autopilot:claimed` is a safety net for a session
// that died before its own cleanup; `autopilot:blocked` is never touched here.
process.on("exit", () => {
  if (pickedIssue) {
    try {
      Bun.spawnSync(["gh", "issue", "edit", pickedIssue, "--remove-label", "autopilot:claimed"], { stdout: "inherit", stderr: "ignore" });
    } catch { /* gh missing */ }
  }
  try { rmdirSync(lock); } catch { /* already gone */ }
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => process.exit(128 + constants.signals[sig]));
}

if (!Bun.which("claude")) {
  log(`FATAL 'claude' CLI not on PATH (${process.env.PATH ?? ""}) — cannot run autopilot`);
  process.exit(127);
}

// --- Backlog preflight: log what we're about to work on, or skip the tick. ---
// This wrapper only picks; the skill body is the sole claimer, and it binds to
// the issue passed here so the two never disagree.
const issuesTmp = `${TMP}/speckit-autopilot-issues-${process.pid}.json`;
const quiet = { stdout: "ignore", stderr: "ignore" } as const;
const fetched = !!Bun.which("gh")
  && Bun.spawnSync([BUN, FETCH, issuesTmp], quiet).exitCode === 0
  && existsSync(issuesTmp) && statSync(issuesTmp).size > 0;
if (fetched) {
  // --cross-repo: a fix shipped in ANOTHER repo is invisible to every other check (issue #34).
  const r = Bun.spawnSync([BUN, PREFLIGHT, issuesTmp, "--cross-repo"], { stdout: "pipe", stderr: "ignore" });
  const preflight = r.exitCode === 0 ? r.stdout.toString().replace(/\n+$/, "") : "";
  rmSync(issuesTmp, { force: true });

  if (!preflight) {
    log("preflight: could not evaluate issues — proceeding anyway");
  } else {
    // Verdict is the FIRST line; `DELIVERED: <n> <pr>` park requests follow.
    const lines = preflight.split("\n");
    const verdict = lines[0]!;
    // Park deliveries before acting on the verdict: SKIP exits without launching
    // the skill, so otherwise they would be rediscovered every tick.
    for (const line of lines) {
      if (!line.startsWith("DELIVERED: ")) continue;
      const [, num = "", ...prParts] = line.trim().split(/\s+/);
      const pr = prParts.join(" ");
      log(`preflight: #${num} already delivered by ${pr} — parking`);
      const parked = Bun.spawnSync([BUN, PARK, num,
        `delivered by ${pr} — close this issue, or clear the autopilot:blocked label if that PR does not resolve it`,
        "--title", "✅ **Already delivered**"], quiet).exitCode === 0;
      if (!parked) log(`preflight: WARNING could not park #${num}; it will be re-checked next tick`);
    }
    if (verdict.startsWith("SKIP:")) {
      log(`preflight: ${verdict}`);
      process.exit(0);
    }
    pickedIssue = verdict.match(/#([0-9]+)/)?.[1] ?? "";
    log(`preflight: ${verdict}`);
  }
} else {
  rmSync(issuesTmp, { force: true });
  log("preflight: gh unavailable or no issues fetched — proceeding anyway");
}

// Tells preflight-issues.ts nobody is reading: a STALE branch/worktree stays a
// hard SKIP instead of a resume-or-clean offer (issue #60). Bun.spawn snapshots
// env at startup, so the claude spawns below pass process.env explicitly.
process.env.SPECKIT_AUTOPILOT_UNATTENDED = "1";

log(`=== autopilot pass start :: ${PROJECT} ===`);
const prompt = pickedIssue ? `/speckit-autopilot-run ${pickedIssue}` : "/speckit-autopilot-run";
let status: number;

if (existsSync(DECODER)) {
  let raw = process.env.AUTOPILOT_RAW_LOG ?? rawLogFor(PROJECT);
  let fd: number | undefined;
  if (raw) {
    try {
      mkdirSync(dirname(raw), { recursive: true });
      // Cheap rotation so an unattended repo can't fill the disk.
      if (existsSync(raw) && statSync(raw).size > RAW_MAX_BYTES) try { renameSync(raw, `${raw}.1`); } catch { /* keep appending */ }
      fd = openSync(raw, "a");
      log(`raw stream -> ${raw}`);
    } catch {
      log(`WARNING cannot write raw stream to ${raw} — decoding only`);
      raw = "";
    }
  }
  // `exec … 2>&1` folds stderr into the stream exactly as the bash pipe did;
  // the decoder passes non-JSON lines through.
  const claude = Bun.spawn(["/bin/sh", "-c", 'exec "$@" 2>&1', "sh",
    "claude", "-p", prompt, "--dangerously-skip-permissions", "--verbose", "--output-format", "stream-json"],
    { env: process.env, stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const decoder = Bun.spawn([BUN, DECODER], { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
  for await (const chunk of claude.stdout) {
    if (fd !== undefined) writeSync(fd, chunk);
    try { decoder.stdin.write(chunk); } catch { /* decoder gone; keep the raw copy */ }
  }
  try { await decoder.stdin.end(); } catch { /* already closed */ }
  await decoder.exited;
  if (fd !== undefined) closeSync(fd);
  // claude's own exit code, not the decoder's (bash used PIPESTATUS[0]).
  const code = await claude.exited;
  status = claude.signalCode ? 128 + constants.signals[claude.signalCode] : code;
} else {
  const claude = Bun.spawn(["claude", "-p", prompt, "--dangerously-skip-permissions"], { env: process.env, stdio: ["inherit", "inherit", "inherit"] });
  const code = await claude.exited;
  status = claude.signalCode ? 128 + constants.signals[claude.signalCode] : code;
}
log(`=== autopilot pass end (exit ${status}) ===`);
process.exit(status);
