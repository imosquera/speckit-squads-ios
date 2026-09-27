#!/usr/bin/env bun
// git extension: clean.ts
// Clean up a feature: discard uncommitted work, close its issue, remove its
// worktree and delete its branch. Gated by verify-landed.ts, which must prove
// the work is on the base; the gate fails closed (issue #49).
//
// Usage: clean.ts [--force|-f] [--base <ref>] [--worktree <path>] [--spec <path>] [--issue <number>] [target]
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { resolveFeature } from "./git-common.ts";

let force = false;
let baseBranch = "";
let targetWorktree = "";
let targetSpec = "";
let targetIssue = "";
const positional: string[] = [];

function fail(msg: string): never {
  console.error(`[clean] ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? "";
  const next = (what: string) => {
    if (i + 1 >= argv.length) fail(`${a} requires ${what}`);
    return argv[++i] ?? "";
  };
  if (a === "--force" || a === "-f") force = true;
  else if (a === "--base") baseBranch = next("a ref");
  else if (a === "--worktree") targetWorktree = next("a path");
  else if (a === "--spec") targetSpec = next("a path");
  else if (a === "--issue") targetIssue = next("a number");
  else if (a === "--help" || a === "-h") {
    console.log(`Usage: clean.ts [--force|-f] [--base <ref>] [--worktree <path>] [--spec <path>] [--issue <number>] [target]

Targets may be a worktree path, a spec directory, or an issue number.

Refuses to clean unless verify-landed.ts proves the branch's work is on the
base (default main) — a squash merge leaves no ancestry, so content is what is
checked. A detached HEAD is verified by its commit sha; if the check cannot run
at all (no resolvable HEAD, or no verify-landed.ts) it refuses too.
--force overrides, discarding whatever the branch still holds.`);
    process.exit(0);
  } else positional.push(a);
}

if (positional.length > 1) fail("only one positional target may be given");
const pos = positional[0] ?? "";
if (!targetWorktree && !targetSpec && !targetIssue && pos) {
  if (/^#?[0-9]+$/.test(pos)) targetIssue = pos.replace(/^#/, "");
  else if (pos.startsWith("specs/") || pos.includes("/specs/")) targetSpec = pos;
  else targetWorktree = pos;
}
if ([targetWorktree, targetSpec, targetIssue].filter(Boolean).length > 1) fail("pick exactly one of --worktree, --spec, or --issue");

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
function findProjectRoot(dir: string): string | null {
  for (; dir !== "/"; dir = dirname(dir)) if (isDir(`${dir}/.specify`) || isDir(`${dir}/.git`)) return dir;
  return null;
}

const scriptDir = import.meta.dir;
process.chdir(findProjectRoot(scriptDir) ?? process.cwd());

function git(...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().replace(/\n+$/, "") };
}
// A step bash ran under `set -e`: output shown, failure aborts.
function must(...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
}
const prefixed = (text: string, prefix: string) =>
  text
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");

if (!Bun.which("git")) fail("git not found");
if (!git("rev-parse", "--is-inside-work-tree").ok) fail("not a git repository");

let worktreeRoot: string;
if (targetWorktree) worktreeRoot = targetWorktree;
else if (targetSpec && isDir(targetSpec) && basename(dirname(targetSpec)) === "specs") worktreeRoot = dirname(dirname(targetSpec));
else worktreeRoot = git("rev-parse", "--show-toplevel").out;
if (!isDir(worktreeRoot)) fail(`cannot enter ${worktreeRoot}: no such directory`);
worktreeRoot = resolve(worktreeRoot);

const featureJson = `${worktreeRoot}/.specify/feature.json`;
const branchName = git("-C", worktreeRoot, "branch", "--show-current").out;

// Worktree and spec dir come from git, never a file (issue #33); only source_issue is read from feature.json.
let featureDirectory = "";
let sourceIssue = "";
const feature = resolveFeature(worktreeRoot);
if (feature) {
  featureDirectory = feature.directory;
  sourceIssue = feature.sourceIssue;
} else {
  const slug = branchName.replace(/^.*\//, "");
  if (slug && isDir(`${worktreeRoot}/specs/${slug}`)) featureDirectory = `specs/${slug}`;
  try {
    sourceIssue = /"source_issue"\s*:\s*([0-9]+)/.exec(readFileSync(featureJson, "utf8"))?.[1] ?? "";
  } catch {}
}

if (targetIssue) {
  if (!sourceIssue) fail(`no source_issue recorded in ${featureJson}; cannot match issue #${targetIssue}`);
  if (sourceIssue !== targetIssue) fail(`recorded source_issue #${sourceIssue} does not match requested issue #${targetIssue}`);
}
if (!featureDirectory && !targetSpec && !targetWorktree && !targetIssue) {
  fail(
    `cannot derive a feature from branch '${branchName || "?"}' in ${worktreeRoot} (no matching specs/ directory); pass --worktree, --spec, or --issue to identify the feature`,
  );
}

// Nothing below is reversible, so the landed question is answered once, by
// verify-landed.ts. Fail closed: a detached HEAD is verified by sha, and an
// unrunnable check refuses rather than skips.
const baseName = baseBranch || "main";
let verifyTarget = branchName;
let verifyWhat = `branch '${branchName}'`;
if (!verifyTarget) {
  verifyTarget = git("-C", worktreeRoot, "rev-parse", "--verify", "--quiet", "HEAD").out;
  verifyWhat = `detached HEAD ${verifyTarget.slice(0, 8)}`;
}
const verifier = `${scriptDir}/verify-landed.ts`;
let blocked = "";
if (!verifyTarget) blocked = `no branch and no resolvable HEAD in ${worktreeRoot}`;
else if (!existsSync(verifier)) blocked = `verify-landed.ts is missing at ${verifier}`;

if (blocked) {
  if (!force) {
    fail(`refusing to clean ${worktreeRoot}: ${blocked} — the landed check cannot run, so nothing proves this work is on ${baseName} (use --force to override)`);
  }
  console.error(`[clean] --force: ${blocked}; cleaning without the landed check`);
} else {
  const args = [verifyTarget, "--repo", worktreeRoot, ...(baseBranch ? ["--base", baseBranch] : [])];
  const r = Bun.spawnSync([process.execPath, verifier, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = prefixed(r.stdout.toString() + r.stderr.toString(), "[clean] ");
  if (r.exitCode === 0) console.log(out);
  else {
    console.error(out);
    if (!force) fail(`refusing to clean ${verifyWhat}: its work is not provably on ${baseName} (use --force to override)`);
    console.error(`[clean] --force: cleaning ${verifyWhat} anyway; the work above is being discarded`);
  }
}

// Scrub commit_exclude churn first, so a background rebuild does not block the clean (issues #62, #55).
Bun.spawnSync([process.execPath, `${scriptDir}/scrub-commit-exclude.ts`, "--repo", worktreeRoot], { stdout: "inherit", stderr: "inherit" });

const status = Bun.spawnSync(["git", "-C", worktreeRoot, "status", "--porcelain"], { stdout: "pipe", stderr: "inherit" });
if (status.exitCode !== 0) process.exit(status.exitCode ?? 1);
const statusFiles = status.stdout.toString().replace(/\n+$/, "");
if (statusFiles) {
  if (!force) {
    console.error(`[clean] refusing to discard uncommitted changes in ${worktreeRoot} (use --force to override):`);
    console.error(prefixed(statusFiles, "[clean]   "));
    process.exit(1);
  }
  console.error(`[clean] --force: discarding uncommitted changes in ${worktreeRoot}`);
  must("-C", worktreeRoot, "reset", "--hard");
  must("-C", worktreeRoot, "clean", "-fd");
}

if (sourceIssue) {
  if (!Bun.which("gh")) console.error(`[clean] gh CLI not found; skipping issue close (#${sourceIssue})`);
  else if (Bun.spawnSync(["gh", "issue", "view", sourceIssue], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) {
    const close = Bun.spawnSync(["gh", "issue", "close", sourceIssue, "-c", `Feature cleaned up from ${featureDirectory || worktreeRoot}.`], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (close.exitCode !== 0) console.error(`[clean] warning: failed to close issue #${sourceIssue}`);
    console.log(`[clean] closed issue #${sourceIssue}`);
  } else {
    console.error(`[clean] issue #${sourceIssue} not visible to gh; skipping close`);
  }
}

const primaryLine = git("worktree", "list", "--porcelain").out.split("\n").find((l) => l.startsWith("worktree "));
const primary = primaryLine?.slice("worktree ".length) || worktreeRoot;

if (worktreeRoot !== primary && isDir(worktreeRoot)) {
  console.log(`[clean] removing worktree ${worktreeRoot}`);
  must("-C", primary, "worktree", "remove", "--force", worktreeRoot);
} else if (worktreeRoot === primary) {
  console.log("[clean] target is the primary checkout; worktree removal skipped");
}

if (branchName && git("-C", primary, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`).ok) {
  const del = Bun.spawnSync(["git", "-C", primary, "branch", "-D", branchName], { stdout: "inherit", stderr: "inherit" });
  if (del.exitCode === 0) console.log(`[clean] deleted branch ${branchName}`);
  else console.error(`[clean] warning: branch ${branchName} could not be deleted`);
}

console.log(featureDirectory ? `[clean] cleaned feature ${featureDirectory}` : `[clean] cleaned worktree ${worktreeRoot}`);
