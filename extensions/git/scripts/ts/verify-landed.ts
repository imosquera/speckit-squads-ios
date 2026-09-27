#!/usr/bin/env bun
// git extension: verify-landed.ts
// Has <branch>'s work landed on <base>, so deleting the branch loses nothing?
// Squash merges break ancestry, so this compares content: every path the branch
// touched since its fork point, minus the repo's declared `commit_exclude` (issue #49).
//
// Usage: verify-landed.ts <branch> [--base <ref>] [--repo <dir>] [--exclude <path>]...
//                         [--no-fetch] [--json]
//
// Contract (clean.ts and agents grep it): first stdout line is
// `LANDED:` / `NOT-LANDED:` / `UNKNOWN:`; exit 0 LANDED, 1 NOT-LANDED, 2 UNKNOWN.
// Only exit 0 authorizes a destructive step. --json replaces the LANDED/NOT-LANDED
// text with one JSON line of fixed shape.
import { resolve } from "node:path";
import { statSync } from "node:fs";
import { commitExcludes } from "./git-common.ts";

const USAGE =
  "[verify-landed] Usage: verify-landed.ts <branch> [--base <ref>] [--repo <dir>] [--exclude <path>]... [--no-fetch] [--json]";

function dieUsage(msg: string): never {
  console.error(`[verify-landed] ${msg}`);
  console.error(USAGE);
  process.exit(2);
}

function unknown(msg: string): never {
  console.log(`UNKNOWN: ${msg}`);
  process.exit(2);
}

let branch = "";
let base = "";
let repo = "";
let doFetch = true;
let json = false;
const excludes: string[] = [];

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? "";
  const next = (what: string) => {
    if (i + 1 >= argv.length) dieUsage(`${a} requires ${what}`);
    return argv[++i] ?? "";
  };
  if (a === "--base") base = next("a ref");
  else if (a === "--repo") repo = next("a directory");
  else if (a === "--exclude") excludes.push(next("a path"));
  else if (a === "--no-fetch") doFetch = false;
  else if (a === "--json") json = true;
  else if (a === "--help" || a === "-h") {
    console.log(`Usage: verify-landed.ts <branch> [--base <ref>] [--repo <dir>] [--exclude <path>]...
                        [--no-fetch] [--json]

Verdict (first line of stdout):
  LANDED:     the work is on <base> — ancestry proves it, or the trees are identical
  NOT-LANDED: <branch> carries content <base> does not have; the differing paths follow
  UNKNOWN:    the question could not be answered (no such branch, unresolvable base, …)

Exit: 0 = LANDED, 1 = NOT-LANDED, 2 = UNKNOWN. UNKNOWN is a refusal, never a pass.`);
    process.exit(0);
  } else if (a.startsWith("-")) dieUsage(`unknown option: ${a}`);
  else {
    if (branch) dieUsage("only one branch may be given");
    branch = a;
  }
}
if (!branch) dieUsage("no branch given");

if (!Bun.which("git")) unknown("git not found — cannot verify anything; do not delete");

if (repo) {
  repo = resolve(repo);
  let isDir = false;
  try {
    isDir = statSync(repo).isDirectory();
  } catch {}
  if (!isDir) unknown("--repo path does not exist; do not delete");
} else {
  repo = process.cwd();
}

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().replace(/\n+$/, "") };
}
const lines = (s: string) => s.split("\n").filter((l) => l !== "");

if (!git(repo, "rev-parse", "--is-inside-work-tree").ok) unknown(`${repo} is not a git repository; do not delete`);
const top = git(repo, "rev-parse", "--show-toplevel");
const root = top.ok ? top.out : repo;
const g = (...args: string[]) => git(root, ...args);

if (!g("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).ok && !g("rev-parse", "--verify", "--quiet", `${branch}^{commit}`).ok) {
  unknown(`no such branch or commit '${branch}' — nothing to verify; do not delete`);
}

base ||= "main";

// Remote-tracking ref first: a GitHub squash moves origin/main, not the local
// main, and comparing against a stale local main reads a landed branch as NOT-LANDED.
function resolveBase(): string | null {
  const bare = base.replace(/^origin\//, "");
  if (doFetch && g("remote", "get-url", "origin").ok) {
    Bun.spawnSync(["git", "-C", root, "fetch", "--quiet", "origin", bare], { stdout: "ignore", stderr: "ignore" });
  }
  for (const c of [`origin/${bare}`, `refs/remotes/origin/${bare}`, base]) {
    if (g("rev-parse", "--verify", "--quiet", `${c}^{commit}`).ok) return c;
  }
  return null;
}

const baseRef = resolveBase();
if (baseRef === null) unknown(`base '${base}' does not resolve to a commit here — cannot prove anything; do not delete`);

// --exclude adds to commit_exclude; it never replaces it.
excludes.push(...commitExcludes(root));
const pathspec = ["--", ".", ...excludes.map((e) => `:(exclude)${e}`)];

const branchSha = g("rev-parse", `${branch}^{commit}`).out;
const baseSha = g("rev-parse", `${baseRef}^{commit}`).out;
let pathsChecked = 0;

function emit(verdict: string, via: string, code: number): void {
  if (json) {
    console.log(
      `{"landed": ${code === 0}, "verdict": "${verdict}", "branch": "${branch}", "base": "${baseRef}", "via": "${via}", "paths_checked": ${pathsChecked}}`,
    );
  }
}

// 1. Ancestry: a true merge or fast-forward.
if (g("merge-base", "--is-ancestor", branchSha, baseSha).ok) {
  if (!json) console.log(`LANDED: ${branch} (${branchSha.slice(0, 8)}) is an ancestor of ${baseRef} (${baseSha.slice(0, 8)}) — merged or fast-forwarded`);
  emit("LANDED", "ancestry", 0);
  process.exit(0);
}

// 2. Content: every path any branch commit touched (log --name-only, so a path
// changed then reverted still counts), unioned with the endpoint diff (covers merges).
const mergeBase = g("merge-base", baseSha, branchSha);
let compare: string[];
if (mergeBase.ok && mergeBase.out) {
  const range = `${mergeBase.out}..${branchSha}`;
  const changed = [
    ...new Set([
      ...lines(g("log", "--format=", "--name-only", range, ...pathspec).out),
      ...lines(g("diff", "--name-only", mergeBase.out, branchSha, ...pathspec).out),
    ]),
  ].sort();
  if (changed.length === 0) {
    if (!json) console.log(`LANDED: ${branch} (${branchSha.slice(0, 8)}) introduces no changes over its fork point — nothing to lose`);
    emit("LANDED", "empty", 0);
    process.exit(0);
  }
  pathsChecked = changed.length;
  compare = ["--", ...changed];
} else {
  // Unrelated histories: no fork point, so compare the whole tree.
  compare = pathspec;
  pathsChecked = lines(g("ls-tree", "-r", "--name-only", branchSha, ...pathspec).out).length;
}

const diff = g("diff", "--name-only", baseSha, branchSha, ...compare);
if (!diff.ok) unknown(`could not diff ${branch} against ${baseRef}; do not delete`);

if (!diff.out) {
  if (!json) {
    console.log(`LANDED: ${branch} (${branchSha.slice(0, 8)}) has no content ${baseRef} (${baseSha.slice(0, 8)}) lacks — squash-merged or rebased`);
    console.log(
      `        ${pathsChecked} path(s) the branch touched, all identical on the base${excludes.length ? `; excluded: ${excludes.join(" ")}` : ""}`,
    );
  }
  emit("LANDED", "content", 0);
  process.exit(0);
}

if (json) {
  emit("NOT-LANDED", "diff", 1);
} else {
  const d = diff.out.split("\n");
  console.log(
    `NOT-LANDED: ${branch} differs from ${baseRef} in ${d.length} of ${pathsChecked} path(s) it touched — the work is NOT on the base; refuse to delete`,
  );
  console.log(`--- paths whose branch content is not on ${baseRef} ---`);
  console.log(d.slice(0, 50).join("\n"));
}
process.exit(1);
