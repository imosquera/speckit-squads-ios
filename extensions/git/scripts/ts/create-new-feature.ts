#!/usr/bin/env bun
// Git extension: create-new-feature.ts — create a feature branch + dedicated worktree,
// numbered from its GitHub issue (created here, or bound via --source-issue).
//
// Contract: stdout (--json object, or the KEY: lines), the branch/worktree naming and
// the exit codes are read by the autopilot extension and /speckit-git-feature.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { effectiveBranchName, hasGit, writeFeatureJson } from "./git-common.ts";

const SCRIPT_DIR = import.meta.dir;
const SELF = process.argv[1] ?? "create-new-feature.ts";
const USAGE = `Usage: ${SELF} [--json] [--dry-run] [--allow-existing-branch] [--short-name <name>] [--number N] [--source-issue N] [--timestamp] <feature_description>`;

const err = (s: string) => console.error(s);
function die(msg: string): never {
  err(msg);
  process.exit(1);
}

function run(cmd: string[], env?: Record<string, string>): { ok: boolean; out: string; all: string } {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env: env ? { ...process.env, ...env } : undefined });
  const out = r.stdout.toString();
  return { ok: r.exitCode === 0, out, all: (out + r.stderr.toString()).replace(/\n+$/, "") };
}
const gitOut = (...args: string[]) => run(["git", ...args]);

// bash `printf %q` (the shapes a path or branch can take).
function shq(s: string): string {
  if (s === "") return "''";
  if (/[\x00-\x1f\x7f]/.test(s)) {
    const esc: Record<string, string> = { "\n": "\\n", "\t": "\\t", "\r": "\\r", "\\": "\\\\", "'": "\\'" };
    return `$'${s.replace(/[\x00-\x1f\x7f\\']/g, (c) => esc[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`)}'`;
  }
  return s.replace(/[ \t'"\\|&;()<>!{}*[?\]^$`,]|^[~#]/g, "\\$&");
}

// ---- args
let jsonMode = false, dryRun = false, allowExisting = false, useTimestamp = false;
let shortName = "", branchNumber = "", sourceIssue = "", issueUrl = "", issueCreatedHere = false;
const rest: string[] = [];
const argv = process.argv.slice(2);
function value(i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith("--")) die(`Error: ${flag} requires a value`);
  return v;
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  switch (a) {
    case "--json": jsonMode = true; break;
    case "--dry-run": dryRun = true; break;
    case "--allow-existing-branch": allowExisting = true; break;
    case "--timestamp": useTimestamp = true; break;
    case "--short-name": shortName = value(++i, a); break;
    case "--number":
      branchNumber = value(++i, a);
      if (!/^[0-9]+$/.test(branchNumber)) die("Error: --number must be a non-negative integer");
      break;
    case "--source-issue":
      sourceIssue = value(++i, a).replace(/^#/, "");
      if (!/^[0-9]+$/.test(sourceIssue)) die("Error: --source-issue must be a positive integer issue number");
      break;
    case "--help":
    case "-h":
      console.log(`${USAGE}

Options:
  --json              Output in JSON format
  --dry-run           Compute branch name without creating the branch
  --allow-existing-branch  Switch to branch if it already exists instead of failing
  --short-name <name> Provide a custom short name (2-4 words) for the branch
  --number N          Specify branch number manually (overrides auto-detection)
  --source-issue N    Bind to an EXISTING GitHub issue #N instead of creating a new
                      stub issue; N also drives numbering unless --number/--timestamp/
                      GIT_BRANCH_NAME already fix the branch name
  --timestamp         Use timestamp prefix (YYYYMMDD-HHMMSS) instead of sequential numbering
  --help, -h          Show this help message

Environment variables:
  GIT_BRANCH_NAME     Use this exact branch name, bypassing all prefix/suffix generation

Examples:
  ${SELF} 'Add user authentication system' --short-name 'user-auth'
  ${SELF} 'Implement OAuth2 integration for API' --number 5
  ${SELF} --timestamp --short-name 'user-auth' 'Add user authentication'
  ${SELF} --source-issue 90 --short-name 'automatic-arrival' 'Automatic arrival detection'
  GIT_BRANCH_NAME=my-branch ${SELF} 'feature description'`);
      process.exit(0);
    default: rest.push(a);
  }
}

let description = rest.join(" ");
if (!description) die(USAGE);
// sed trims each line; $(...) drops trailing newlines.
description = description
  .split("\n")
  .map((l) => l.replace(/^[ \t\r\v\f]+|[ \t\r\v\f]+$/g, ""))
  .join("\n")
  .replace(/\n+$/, "");
if (!description) die("Error: Feature description cannot be empty or contain only whitespace");

// ---- numbering helpers
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
// Sequential prefix (>=3 digits), timestamp names skipped.
function highestOf(names: string[]): number {
  let hi = 0;
  for (const n of names) {
    if (!/^[0-9]{3,}-/.test(n) || /^[0-9]{8}-[0-9]{6}-/.test(n)) continue;
    hi = Math.max(hi, Number(/^[0-9]+/.exec(n)![0]));
  }
  return hi;
}
function highestFromSpecs(specsDir: string): number {
  if (!isDir(specsDir)) return 0;
  const names = readdirSync(specsDir).filter((d) => !d.startsWith(".") && isDir(join(specsDir, d)));
  return highestOf(names);
}
// Same text munging as `git branch -a | sed 's/^[* ]*//; s|^remotes/[^/]*/||'`.
function highestFromBranches(): number {
  const r = gitOut("branch", "-a");
  const lines = r.ok ? r.out.split("\n") : [];
  return highestOf(lines.map((l) => l.replace(/^[* ]*/, "").replace(/^remotes\/[^/]*\//, "")));
}
// ls-remote, no fetch (side-effect free, for --dry-run).
function highestFromRemoteRefs(): number {
  let hi = 0;
  const remotes = gitOut("remote");
  for (const remote of remotes.ok ? remotes.out.split(/\s+/).filter(Boolean) : []) {
    const r = run(["git", "ls-remote", "--heads", remote], { GIT_TERMINAL_PROMPT: "0" });
    hi = Math.max(hi, highestOf(r.out.split("\n").map((l) => l.replace(/.*refs\/heads\//, ""))));
  }
  return hi;
}
function nextFree(specsDir: string, skipFetch = false): number {
  let hiBranch: number;
  if (skipFetch) {
    hiBranch = Math.max(highestFromRemoteRefs(), highestFromBranches());
  } else {
    run(["git", "fetch", "--all", "--prune"]);
    hiBranch = highestFromBranches();
  }
  return Math.max(hiBranch, highestFromSpecs(specsDir)) + 1;
}

// GNU sed semantics (runs of '-' collapse); BSD sed ignored `\+` and left them.
function cleanBranchName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-/, "").replace(/-$/, "");
}

const STOP = new Set(
  "i a an the to for of in on at by with from is are was were be been being have has had do does did will would should could can may might must shall this that these those my your our their want need add get set".split(" "),
);
function generateBranchName(desc: string): string {
  const words = desc.toLowerCase().replace(/[^a-z0-9]/g, " ").split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => {
    if (STOP.has(w)) return false;
    if (w.length >= 3) return true;
    // Short words survive only as an uppercase acronym in the description (grep -w).
    return new RegExp(`(^|[^A-Za-z0-9_])${w.toUpperCase()}([^A-Za-z0-9_]|$)`, "m").test(desc);
  });
  if (meaningful.length) return meaningful.slice(0, meaningful.length === 4 ? 4 : 3).join("-");
  return cleanBranchName(desc).split("-").filter(Boolean).slice(0, 3).join("-");
}

// ---- repo root: core common.sh's get_repo_root when core is installed, else git.
function findProjectRoot(dir: string): string {
  for (; dir !== "/"; dir = dirname(dir)) {
    if (isDir(`${dir}/.specify`) || isDir(`${dir}/.git`)) return dir;
  }
  return "";
}
function findSpecifyRoot(dir: string): string {
  for (let prev = ""; dir !== prev; prev = dir, dir = dirname(dir)) {
    if (isDir(`${dir}/.specify`)) return dir;
  }
  return "";
}
function repoRoot(): string {
  const project = findProjectRoot(SCRIPT_DIR);
  const core = [`${project}/.specify/scripts/bash/common.sh`, `${project}/scripts/bash/common.sh`].find(
    (p) => project && existsSync(p),
  );
  if (core) {
    const init = process.env.SPECIFY_INIT_DIR;
    if (init) {
      if (!isDir(init)) die(`ERROR: SPECIFY_INIT_DIR does not point to an existing directory: ${init}`);
      const abs = resolve(init);
      if (!isDir(`${abs}/.specify`)) die(`ERROR: SPECIFY_INIT_DIR is not a Spec Kit project (no .specify/ directory): ${abs}`);
      return abs;
    }
    return findSpecifyRoot(process.cwd()) || dirname(dirname(dirname(dirname(core))));
  }
  const top = gitOut("rev-parse", "--show-toplevel");
  if (top.ok) return top.out.replace(/\n+$/, "");
  if (project) return project;
  die("Error: Could not determine repository root.");
}

const REPO_ROOT = repoRoot();
const HAS_GIT = hasGit(REPO_ROOT);
process.chdir(REPO_ROOT);
const SPECS_DIR = `${REPO_ROOT}/specs`;
const GIT_BRANCH_NAME = process.env.GIT_BRANCH_NAME ?? "";

// branch_numbering: timestamp in git-config.yml, then init-options.json.
if (!useTimestamp && !GIT_BRANCH_NAME) {
  let numbering = "";
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const yaml = read(`${REPO_ROOT}/.specify/extensions/git/git-config.yml`);
  const line = yaml?.split("\n").find((l) => /^[ \t]*branch_numbering:/.test(l));
  if (line) {
    numbering = line
      .replace(/^[ \t]*branch_numbering:[ \t]*/, "")
      .replace(/[ \t\r]*$/, "")
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1")
      .toLowerCase();
  }
  const json = numbering ? null : read(`${REPO_ROOT}/.specify/init-options.json`);
  if (json !== null) {
    try {
      const v = (JSON.parse(json) as { branch_numbering?: unknown } | null)?.branch_numbering;
      if (typeof v === "string") numbering = v.toLowerCase();
    } catch {}
  }
  if (numbering === "timestamp") useTimestamp = true;
}

// ---- branch name
let branchName: string, featureNum: string, branchSuffix: string;
if (GIT_BRANCH_NAME) {
  branchName = GIT_BRANCH_NAME;
  const m = /^[0-9]{8}-[0-9]{6}(?=-)/.exec(branchName) ?? /^[0-9]+(?=-)/.exec(branchName);
  featureNum = m ? m[0] : branchName;
  branchSuffix = m ? branchName.slice(m[0].length + 1) : branchName;
} else {
  branchSuffix = shortName ? cleanBranchName(shortName) : generateBranchName(description);

  if (useTimestamp && branchNumber) {
    err("[specify] Warning: --number is ignored when --timestamp is used");
    branchNumber = "";
  }

  // The issue drives FEATURE_NUM so spec dir, branch and issue share one number.
  // `gh` is required unless the caller opted out (timestamp/number/source-issue/dry-run/env).
  const specsNext = () => (HAS_GIT ? nextFree(SPECS_DIR, dryRun) : highestFromSpecs(SPECS_DIR) + 1);
  if (!useTimestamp && !branchNumber && !sourceIssue && !dryRun && HAS_GIT) {
    const bypass = "[specify]   or pass --timestamp / --number / GIT_BRANCH_NAME to bypass issue creation.";
    if (!Bun.which("gh")) {
      err("[specify] Error: `gh` is required for /speckit-git-feature but is not installed.");
      err("[specify]   Install GitHub CLI from https://cli.github.com/ and run `gh auth login`,");
      die(bypass);
    }
    if (!run(["gh", "auth", "status"]).ok) {
      err("[specify] Error: `gh` is installed but not authenticated.");
      err("[specify]   Run `gh auth login`,");
      die(bypass);
    }
    const body = `Tracking issue for feature: ${description}\n\nStub created by \`/speckit-git-feature\`. The full spec body will be filled in by \`/speckit-specify\`.`;
    const r = run(["gh", "issue", "create", "--title", description, "--body", body]);
    // Raw, unindented: bash's `>&2 printf ... | sed` sent the output around its sed.
    const indented = r.all;
    if (!r.ok) die(`[specify] Error: \`gh issue create\` failed:\n${r.all}`);
    issueUrl = /https?:\/\/\S+\/issues\/[0-9]+/.exec(r.all)?.[0] ?? "";
    sourceIssue = /[0-9]+$/.exec(issueUrl)?.[0] ?? "";
    if (!sourceIssue) die(`[specify] Error: created issue but could not parse number from gh output:\n${r.all}`);
    issueCreatedHere = true;
    err(`[specify] Created GitHub issue #${sourceIssue}: ${issueUrl}`);

    // An issue counter behind existing specs/branches would reuse a taken slot.
    const next = specsNext();
    if (Number(sourceIssue) < next) {
      err(`[specify] Issue #${sourceIssue} is behind next free spec number ${next}; using ${next} for FEATURE_NUM (issue title will be updated to match).`);
      branchNumber = String(next);
    } else branchNumber = sourceIssue;
  } else if (sourceIssue && !useTimestamp && !branchNumber) {
    const next = specsNext();
    if (Number(sourceIssue) < next) {
      err(`[specify] Issue #${sourceIssue} is behind next free spec number ${next}; using ${next} for FEATURE_NUM.`);
      branchNumber = String(next);
    } else branchNumber = sourceIssue;
  }

  if (useTimestamp) {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    featureNum = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  } else {
    if (!branchNumber) branchNumber = String(HAS_GIT ? nextFree(SPECS_DIR, dryRun) : highestFromSpecs(SPECS_DIR) + 1);
    featureNum = String(Number(branchNumber)).padStart(3, "0");
  }
  branchName = `${featureNum}-${branchSuffix}`;
}

// GitHub's 244-byte branch limit.
const MAX = 244;
const byteLen = Buffer.byteLength(branchName);
if (GIT_BRANCH_NAME && byteLen > MAX) {
  die(`Error: GIT_BRANCH_NAME must be 244 bytes or fewer in UTF-8. Provided value is ${byteLen} bytes.`);
} else if (byteLen > MAX) {
  const truncated = branchSuffix.slice(0, MAX - (featureNum.length + 1)).replace(/-$/, "");
  const original = branchName;
  branchName = `${featureNum}-${truncated}`;
  err("[specify] Warning: Branch name exceeded GitHub's 244-byte limit");
  err(`[specify] Original: ${original} (${original.length} bytes)`);
  err(`[specify] Truncated to: ${branchName} (${branchName.length} bytes)`);
}

// Porcelain `git worktree list` entries; the primary checkout is first.
function worktrees(): { path: string; branch: string }[] {
  const r = gitOut("worktree", "list", "--porcelain");
  const out: { path: string; branch: string }[] = [];
  for (const l of r.ok ? r.out.split("\n") : []) {
    if (l.startsWith("worktree ")) out.push({ path: l.slice(9), branch: "" });
    else if (l.startsWith("branch ") && out.length) out[out.length - 1]!.branch = l.slice(7);
  }
  return out;
}

// Worktree path: <parent-of-primary>/<project>.worktrees/<branch>, project with a
// trailing -main/-master/-trunk stripped. SPECKIT_WORKTREE_PATH / _PARENT override.
let worktreePath = "";
if (HAS_GIT && !dryRun) {
  if (process.env.SPECKIT_WORKTREE_PATH) {
    worktreePath = process.env.SPECKIT_WORKTREE_PATH;
  } else {
    const primary = worktrees()[0]?.path || REPO_ROOT;
    const project = basename(primary).replace(/-(main|master|trunk)$/, "");
    const parent = process.env.SPECKIT_WORKTREE_PARENT || `${dirname(primary)}/${project}.worktrees`;
    mkdirSync(parent, { recursive: true });
    worktreePath = `${parent}/${branchName}`;
  }
}

if (!dryRun) {
  if (HAS_GIT) {
    // The primary checkout is never switched: branch without checkout, then a worktree.
    const b = gitOut("branch", branchName);
    if (!b.ok) {
      if (gitOut("branch", "--list", branchName).out.trim()) {
        if (!allowExisting) {
          die(
            useTimestamp
              ? `Error: Branch '${branchName}' already exists. Rerun to get a new timestamp or use a different --short-name.`
              : `Error: Branch '${branchName}' already exists. Please use a different feature name or specify a different number with --number.`,
          );
        }
      } else {
        err(`Error: Failed to create git branch '${branchName}'.`);
        die(b.all || "Please check your git configuration and try again.");
      }
    }

    // Idempotent when the worktree already sits at the expected path on the expected branch.
    if (worktrees().some((w) => w.path === worktreePath && w.branch === `refs/heads/${branchName}`)) {
      // already there
    } else if (existsSync(worktreePath)) {
      err(`Error: Worktree target path '${worktreePath}' already exists and is not the expected worktree.`);
      die("       Resolve the collision (rm/mv the path, or pass SPECKIT_WORKTREE_PATH) and retry.");
    } else {
      const w = gitOut("worktree", "add", worktreePath, branchName);
      if (!w.ok) {
        err(`Error: Failed to create worktree at '${worktreePath}' for branch '${branchName}'.`);
        if (w.all) err(w.all);
        process.exit(1);
      }
    }
    // Best effort: seed the graph and install deps; neither can fail feature creation.
    for (const s of ["seed-graph.ts", "install-deps.ts"]) {
      if (existsSync(`${SCRIPT_DIR}/${s}`)) {
        Bun.spawnSync([process.execPath, `${SCRIPT_DIR}/${s}`, worktreePath], { stdio: ["inherit", "inherit", "inherit"] });
      }
    }
  } else {
    err(`[specify] Warning: Git repository not detected; skipped branch + worktree creation for ${branchName}`);
  }

  // feature.json carries source_issue (absent -> purged, so /speckit-git-pr can't close
  // the previous feature's issue) plus feature_directory for core Spec Kit only.
  if (HAS_GIT && worktreePath && isDir(worktreePath)) {
    writeFeatureJson(worktreePath, sourceIssue, `specs/${effectiveBranchName(branchName)}`);
    if (sourceIssue) err(`[specify] Linked worktree to issue #${sourceIssue} via .specify/feature.json.`);

    // Only a stub this run created gets the "NNN: " title; a --source-issue title is a human's.
    if (issueCreatedHere && sourceIssue && Bun.which("gh")) {
      if (!run(["gh", "issue", "edit", sourceIssue, "--title", `${featureNum}: ${description}`]).ok) {
        err(`[specify] Warning: failed to prefix issue #${sourceIssue} title with '${featureNum}:'`);
      }
    }
  }

  err(`# To persist: export SPECIFY_FEATURE=${shq(branchName)}`);
  if (worktreePath) {
    err(`# Worktree created at: ${worktreePath}`);
    err(`# NEXT STEP (Constitution v2.3.0 Principle VII): cd ${shq(worktreePath)}`);
  }
  if (issueUrl) err(`# Linked GitHub issue: ${issueUrl}`);
}

if (jsonMode) {
  const o: Record<string, unknown> = { BRANCH_NAME: branchName, FEATURE_NUM: featureNum };
  if (dryRun) o.DRY_RUN = true;
  else {
    o.WORKTREE_PATH = worktreePath;
    if (sourceIssue) Object.assign(o, { SOURCE_ISSUE: Number(sourceIssue), ISSUE_URL: issueUrl });
  }
  console.log(JSON.stringify(o));
} else {
  console.log(`BRANCH_NAME: ${branchName}`);
  console.log(`FEATURE_NUM: ${featureNum}`);
  if (!dryRun && worktreePath) console.log(`WORKTREE_PATH: ${worktreePath}`);
  if (sourceIssue) console.log(`SOURCE_ISSUE: ${sourceIssue}`);
  if (issueUrl) console.log(`ISSUE_URL: ${issueUrl}`);
  if (!dryRun) {
    console.log(`# To persist in your shell: export SPECIFY_FEATURE=${shq(branchName)}`);
    if (worktreePath) console.log(`# NEXT STEP (Constitution v2.3.0 Principle VII): cd ${shq(worktreePath)}`);
  }
}
