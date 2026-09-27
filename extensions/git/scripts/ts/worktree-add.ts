#!/usr/bin/env bun
// Git extension: worktree-add.ts — create a worktree under the same
// <parent-of-primary>/<project>.worktrees/<branch> convention as create-new-feature.ts.
// Exit: 0 ok, 1 git/worktree failure, 2 usage.

import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { effectiveBranchName, writeFeatureDirectory } from "./git-common.ts";

const USAGE = `Usage: ${process.argv[1] ?? "worktree-add.ts"} [--path <absolute-path>] [--parent <absolute-path>] <branch> [start-point]`;
function usageExit(msg?: string): never {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

// bash `printf %q`.
function shq(s: string): string {
  if (s === "") return "''";
  if (/[\x00-\x1f\x7f]/.test(s)) {
    const esc: Record<string, string> = { "\n": "\\n", "\t": "\\t", "\r": "\\r", "\\": "\\\\", "'": "\\'" };
    return `$'${s.replace(/[\x00-\x1f\x7f\\']/g, (c) => esc[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`)}'`;
  }
  return s.replace(/[ \t'"\\|&;()<>!{}*[?\]^$`,]|^[~#]/g, "\\$&");
}

let explicitPath = "", explicitParent = "";
const pos: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--path" || a === "--parent") {
    const v = argv[++i];
    if (v === undefined) usageExit(`Error: ${a} requires a value`);
    if (a === "--path") explicitPath = v;
    else explicitParent = v;
  } else if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else if (a.startsWith("--")) usageExit(`Error: Unknown option: ${a}`);
  else pos.push(a);
}
if (pos.length < 1 || pos.length > 2) usageExit();
const branch = pos[0]!;
const startPoint = pos[1] ?? "";
if (/\s/.test(branch)) {
  console.error("Error: Branch name cannot contain whitespace");
  process.exit(2);
}

function git(...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  return { ok: r.exitCode === 0, out: out.replace(/\n+$/, ""), all: (out + r.stderr.toString()).replace(/\n+$/, "") };
}

if (!Bun.which("git")) {
  console.error("[specify] Warning: Git is not installed; cannot create worktree");
  process.exit(1);
}
if (!git("rev-parse", "--is-inside-work-tree").ok) {
  console.error("[specify] Warning: Current directory is not a Git repository; cannot create worktree");
  process.exit(1);
}
const repoRoot = git("rev-parse", "--show-toplevel").out;
process.chdir(repoRoot);

let worktreePath: string;
if (explicitPath) {
  worktreePath = explicitPath;
} else {
  const first = git("worktree", "list", "--porcelain").out.split("\n")[0] ?? "";
  const primary = /^worktree (.*)/.exec(first)?.[1] || repoRoot;
  const project = basename(primary).replace(/-(main|master|trunk)$/, "");
  const parent = explicitParent || process.env.SPECKIT_WORKTREE_PARENT || `${dirname(primary)}/${project}.worktrees`;
  mkdirSync(parent, { recursive: true });
  worktreePath = `${parent}/${branch}`;
}

if (existsSync(worktreePath)) {
  console.error(`Error: Worktree target path '${worktreePath}' already exists.`);
  console.error("       Choose a different branch/path or pass --path to override.");
  process.exit(1);
}

const add = startPoint
  ? git("worktree", "add", "-b", branch, worktreePath, startPoint)
  : git("show-ref", "--verify", "--quiet", `refs/heads/${branch}`).ok
    ? git("worktree", "add", worktreePath, branch)
    : git("worktree", "add", "-b", branch, worktreePath);
if (!add.ok) {
  console.error(`Error: Failed to create worktree for branch '${branch}'.`);
  if (add.all) console.error(add.all);
  process.exit(1);
}

// feature_directory only: core Spec Kit's get_feature_paths() hard-errors without it.
// Never a source_issue — this script is handed a branch, not an issue.
writeFeatureDirectory(worktreePath, `specs/${effectiveBranchName(branch)}`);

// Best effort: seed the graph and install deps; neither can fail worktree creation.
for (const s of ["seed-graph.ts", "install-deps.ts"]) {
  if (existsSync(`${import.meta.dir}/${s}`)) {
    Bun.spawnSync([process.execPath, `${import.meta.dir}/${s}`, worktreePath], { stdio: ["inherit", "inherit", "inherit"] });
  }
}

console.log(`BRANCH_NAME: ${branch}`);
console.log(`WORKTREE_PATH: ${worktreePath}`);
console.log(`# NEXT STEP: cd ${shq(worktreePath)}`);
