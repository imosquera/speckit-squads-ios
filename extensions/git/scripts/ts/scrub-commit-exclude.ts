#!/usr/bin/env bun
// git extension: scrub-commit-exclude.ts
// The one handler for `commit_exclude` churn (issues #55, #62), called by
// auto-commit.ts, create-pr.ts and clean.ts. Restores every excluded path to
// HEAD (unstage, discard edits, drop untracked output) and reports on stderr.
// A rebuild lock under an excluded path is waited for (SPECKIT_SCRUB_LOCK_TIMEOUT,
// default 30s) rather than raced. Never runs `git clean -x`.
//
// Usage: scrub-commit-exclude.ts [--repo <dir>] [--require-clean] [--quiet]
// Exit: 0 scrubbed or nothing to do (also when git is unavailable),
//       2 --require-clean and dirt remains outside the excluded paths, 1 usage.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { commitExcludes } from "./git-common.ts";

let repo = "";
let requireClean = false;
let quiet = false;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? "";
  if (a === "--repo") {
    if (i + 1 >= argv.length) {
      console.error("[specify] --repo requires a path");
      process.exit(1);
    }
    repo = argv[++i] ?? "";
  } else if (a === "--require-clean") requireClean = true;
  else if (a === "--quiet" || a === "-q") quiet = true;
  else if (a === "--help" || a === "-h") {
    console.log("Usage: scrub-commit-exclude.ts [--repo <dir>] [--require-clean] [--quiet]");
    process.exit(0);
  } else {
    console.error(`[specify] scrub-commit-exclude: unknown argument: ${a}`);
    process.exit(1);
  }
}

if (!Bun.which("git")) process.exit(0);

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().replace(/\n+$/, "") };
}
const firstLine = (s: string) => s.split("\n")[0] ?? "";

if (!repo) repo = git(process.cwd(), "rev-parse", "--show-toplevel").out;
let isDir = false;
try {
  isDir = !!repo && statSync(repo).isDirectory();
} catch {}
if (!isDir) process.exit(0);
repo = resolve(repo);
if (!git(repo, "rev-parse", "--is-inside-work-tree").ok) process.exit(0);

const excludes = commitExcludes(repo).map((e) => e.replace(/\/$/, ""));
if (excludes.length === 0) process.exit(0);

const say = (msg: string) => {
  if (!quiet) console.error(`[specify] ${msg}`);
};

// graphify's hooks rebuild in the background; scrubbing under a live writer re-dirties the tree.
const timeoutRaw = process.env.SPECKIT_SCRUB_LOCK_TIMEOUT ?? "30";
const timeout = /^\s*-?\d+\s*$/.test(timeoutRaw) ? Number(timeoutRaw) : 0;
if (timeout > 0) {
  let waited = 0;
  let done = false;
  while (waited < timeout) {
    let found = "";
    for (const ex of excludes) {
      for (const lock of [`${repo}/${ex}/.rebuild.lock`, `${repo}/${ex}/.lock`, `${repo}/${ex}.lock`]) {
        if (existsSync(lock)) found = lock;
      }
    }
    if (!found) {
      done = true;
      break;
    }
    if (waited === 0) say(`Waiting for a rebuild in flight: ${found} (up to ${timeout}s)`);
    Bun.sleepSync(1000);
    waited++;
  }
  if (!done) say(`Warning: rebuild lock still present after ${timeout}s; scrubbing anyway`);
}

const untracked = (ex: string) => firstLine(git(repo, "ls-files", "--others", "--exclude-standard", "--", ex).out);
const scrubbed: string[] = [];
for (const ex of excludes) {
  const staged = firstLine(git(repo, "diff", "--cached", "--name-only", "--", ex).out);
  const tracked = firstLine(git(repo, "diff", "--name-only", "--", ex).out);
  if (!staged && !tracked && !untracked(ex)) continue;

  const what: string[] = [];
  if (staged) {
    if (!git(repo, "restore", "--staged", "--", ex).ok) git(repo, "rm", "-rq", "--cached", "--ignore-unmatch", "--", ex);
    what.push("unstaged");
  }
  if (staged || tracked) {
    git(repo, "checkout", "--", ex);
    what.push("restored to HEAD");
  }
  // Re-read: unstaging a staged ADDITION leaves it untracked.
  if (untracked(ex)) {
    git(repo, "clean", "-qfd", "--", ex);
    what.push("removed untracked output");
  }
  say(`Scrubbed excluded artifact: ${ex} (${what.join(", ")})`);
  scrubbed.push(ex);
}
if (scrubbed.length === 0) say("commit_exclude: nothing to scrub");

if (requireClean) {
  const rest = git(repo, "status", "--porcelain", "--", ".", ...excludes.map((e) => `:(exclude)${e}`)).out;
  if (rest) {
    console.error("[specify] Working tree still dirty outside commit_exclude:");
    for (const l of rest.split("\n")) console.error(`[specify]   ${l}`);
    process.exit(2);
  }
}
