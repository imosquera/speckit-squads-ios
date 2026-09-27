#!/usr/bin/env bun
// Do the files this issue asks us to change live in the repo this run is bound to?
// Usage: check-target-repo.ts [--repo-root <dir>] <path>...
// Prints INSIDE:/FOREIGN:/OUTSIDE: per target, then a verdict the skill reads:
//   OK: N target(s) inside <repo>           exit 0
//   BLOCKED: N of N target(s) not in <repo>  exit 1   (usage/env errors: exit 2)
// Repo identity is the git COMMON dir, not the toplevel: autopilot runs in a
// worktree, whose toplevel differs from the main repo's (issue #34).

import { dirname, join } from "node:path";
import { statSync } from "node:fs";

const RESOLVE = join(import.meta.dir, "resolve-path.ts");

function git(dir: string, ...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().replace(/\n+$/, "") };
}
const repoId = (dir: string) => git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir").out;
const toplevel = (dir: string, fallback: string) => {
  const r = git(dir, "rev-parse", "--show-toplevel");
  return r.ok ? r.out : fallback;
};
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

const args = process.argv.slice(2);
let repoRoot = "";
while (args[0] === "--repo-root") {
  if (!args[1]) {
    process.stderr.write("[autopilot] Error: --repo-root needs a path\n");
    process.exit(1);
  }
  repoRoot = args[1];
  args.splice(0, 2);
}

if (args.length === 0) {
  process.stderr.write("[autopilot] Usage: check-target-repo.ts [--repo-root <dir>] <path>...\n");
  process.exit(2);
}
if (!Bun.which("git")) {
  process.stderr.write("[autopilot] Error: git not found\n");
  process.exit(2);
}

const oursDir = repoRoot || process.cwd();
const ours = repoId(oursDir);
if (!ours) {
  process.stderr.write(`[autopilot] Error: ${oursDir} is not inside a git repository\n`);
  process.exit(2);
}
const oursName = toplevel(oursDir, oursDir);

let bad = 0;
for (const target of args) {
  // resolve-path.ts: ~ and symlinks resolved; a not-yet-existing file maps to its
  // deepest existing ancestor, the directory it would be created in.
  const r = Bun.spawnSync([process.execPath, RESOLVE, target], { stdout: "pipe", stderr: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode);
  const real = r.stdout.toString().replace(/\n+$/, "");
  const probe = isDir(real) ? real : dirname(real);

  const theirs = repoId(probe);
  if (!theirs) {
    console.log(`OUTSIDE: ${target} → no git repo`);
    bad++;
  } else if (theirs === ours) {
    console.log(`INSIDE: ${target} → ${oursName}`);
  } else {
    console.log(`FOREIGN: ${target} → ${toplevel(probe, theirs)}`);
    bad++;
  }
}

if (bad === 0) {
  console.log(`OK: ${args.length} target(s) inside ${oursName}`);
  process.exit(0);
}
console.log(`BLOCKED: ${bad} of ${args.length} target(s) not in ${oursName}`);
process.exit(1);
