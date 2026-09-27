#!/usr/bin/env bun
// Detect changed files for code review — the single source of review scope for
// /speckit-review-run. Modes: A feature branch (merge-base + uncommitted),
// B working directory, C pull request (--pr <N>, via gh).
//
// Usage: detect-changed-files.ts [--json] [--pr <N>]
// Exit: 0 changes found, 1 error, 2 no changes. The coordinator branches on these.
// JSON carries every key in every mode so the shape is stable; graphify-out/ is
// NOT filtered here (the coordinator drops it).

import { statSync } from "node:fs";

const HELP = `Usage: detect-changed-files.ts [--json] [--pr <N>]

Detect changed files for code review.

  Mode A  feature branch: merge-base with the default branch + staged/unstaged/untracked
  Mode B  default branch: staged/unstaged/untracked working-directory changes
  Mode C  --pr <N>: the PR's files (gh pr diff), diff_base = merge-base of
          origin/<base> and the PR head sha. checkout=worktree when a local
          worktree has the head branch checked out, else checkout=none (read the
          head via \`git show <head>:<path>\`).

OPTIONS:
  --json        Output in JSON format
  --pr <N>      Review pull request N (requires gh)
  --help, -h    Show this help message

EXIT CODES:
  0  Changed files detected successfully
  1  Error (git/gh unavailable, not a git repository, PR or its head unobtainable)
  2  No changes detected
`;

let jsonMode = false;
let prNumber = "";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--json") jsonMode = true;
  else if (a === "--pr") {
    const n = argv[i + 1];
    if (!n || n.startsWith("--")) {
      console.error("ERROR: --pr requires a pull request number");
      process.exit(1);
    }
    prNumber = n;
    i++;
  } else if (a.startsWith("--pr=")) prNumber = a.slice(5);
  else if (a === "--help" || a === "-h") {
    process.stdout.write(HELP);
    process.exit(0);
  } else {
    console.error(`ERROR: Unknown option '${a}'`);
    process.exit(1);
  }
}
if (prNumber && !/^[0-9]+$/.test(prNumber)) {
  console.error(`ERROR: --pr expects a numeric pull request number, got '${prNumber}'`);
  process.exit(1);
}

// Matches the bash json_escape byte for byte (only \ " tab LF CR).
const esc = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");

function errorExit(message: string, code = 1): never {
  if (jsonMode) console.log(`{"error":"${esc(message)}"}`);
  else console.error(`Error: ${message}`);
  process.exit(code);
}

// stdout/stderr with trailing newlines stripped, like $(...).
function run(cmd: string[], opts: { raw?: boolean } = {}): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  return { ok: r.exitCode === 0, out: opts.raw ? out : out.replace(/\n+$/, ""), err: r.stderr.toString().replace(/\n+$/, "") };
}
const git = (...args: string[]) => run(["git", ...args]);
const gitOut = (...args: string[]) => { const r = git(...args); return r.ok ? r.out : ""; };
const gitOk = (...args: string[]) => git(...args).ok;
const gitZ = (...args: string[]) => run(["git", ...args], { raw: true }).out.split("\0");

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

const changed: string[] = [];
const addUnique = (files: string[]) => { for (const f of files) if (f && !changed.includes(f)) changed.push(f); };

if (!Bun.which("git")) errorExit("git is not available. The review extension requires git to identify changed files.");
if (!gitOk("rev-parse", "--git-dir")) errorExit("Not a git repository. The review extension requires git to identify changed files.");

let currentBranch = gitOut("branch", "--show-current");
// Absolute root of THIS worktree, so a reviewer never inherits another checkout's cwd.
let repoRoot = gitOut("rev-parse", "--show-toplevel");
// A base, not a range: two-dot `git diff <base>` reaches staged/unstaged work.
let diffBase = "";
let prUrl = "", prTitle = "", headSha = "", checkout = "";

let defaultBranch = "";
const symref = gitOut("symbolic-ref", "refs/remotes/origin/HEAD");
if (symref) defaultBranch = symref.replace(/^refs\/remotes\/origin\//, "");
if (!defaultBranch && gitOk("rev-parse", "--verify", "origin/main")) defaultBranch = "main";
if (!defaultBranch && gitOk("rev-parse", "--verify", "origin/master")) defaultBranch = "master";

let mode = "";

if (prNumber) {
  if (!Bun.which("gh")) errorExit(`gh is not available. --pr ${prNumber} needs the GitHub CLI to read the pull request.`);
  // One field per line, title last (the only free text); stderr kept apart.
  const view = run(["gh", "pr", "view", prNumber,
    "--json", "number,headRefName,headRefOid,baseRefName,url,title,isCrossRepository",
    "--jq", ".number, .headRefName, .headRefOid, .baseRefName, .url, .isCrossRepository, .title"]);
  if (!view.ok) errorExit(`gh pr view ${prNumber} failed: ${view.err}`);
  const f = view.out.split("\n");
  const headRef = f[1] ?? "";
  headSha = f[2] ?? "";
  const baseRef = f[3] ?? "";
  prUrl = f[4] ?? "";
  const crossRepo = f[5] ?? "";
  prTitle = f[6] ?? "";
  if (!headRef || !headSha || !baseRef) errorExit(`gh pr view ${prNumber} returned no head/base (got: ${view.out})`);

  // The head commit must exist locally: every reviewer reads through it.
  const haveHead = () => gitOk("cat-file", "-e", `${headSha}^{commit}`);
  if (!haveHead()) {
    if (!gitOk("fetch", "-q", "origin", `pull/${prNumber}/head`)) gitOk("fetch", "-q", "origin", headRef);
  }
  if (!haveHead()) errorExit(`PR #${prNumber} head ${headSha} is not in this repository and could not be fetched (tried origin pull/${prNumber}/head and origin ${headRef})`);

  // A stale origin/<base> is tolerated, a missing one is not.
  gitOk("fetch", "-q", "origin", `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`);
  if (!gitOk("rev-parse", "--verify", "-q", `refs/remotes/origin/${baseRef}`)) errorExit(`PR #${prNumber} base origin/${baseRef} is not available locally and could not be fetched`);
  diffBase = gitOut("merge-base", `refs/remotes/origin/${baseRef}`, headSha);
  if (!diffBase) errorExit(`no merge-base between origin/${baseRef} and PR #${prNumber} head ${headSha}`);

  // gh is authoritative for membership; deletions (absent from head) are dropped like ACMR.
  const diff = run(["gh", "pr", "diff", prNumber, "--name-only"]);
  if (!diff.ok) errorExit(`gh pr diff ${prNumber} --name-only failed: ${diff.err}`);
  for (const line of diff.out.split("\n")) {
    if (line && gitOk("cat-file", "-e", `${headSha}:${line}`)) addUnique([line]);
  }

  // Head branch checked out in a local worktree? A fork's branch name says nothing.
  checkout = "none";
  if (crossRepo !== "true") {
    let wt = "";
    for (const line of gitOut("worktree", "list", "--porcelain").split("\n")) {
      if (line.startsWith("worktree ")) wt = line.slice(9);
      else if (line === `branch refs/heads/${headRef}` && wt && isDir(wt)) {
        repoRoot = wt; checkout = "worktree"; break;
      }
    }
  }

  currentBranch = headRef;
  defaultBranch = baseRef;
  mode = `Pull request #${prNumber} (${baseRef}...${headRef} @ ${headSha.slice(0, 12)}), checkout: ${checkout}`;
} else if (currentBranch && defaultBranch && currentBranch !== defaultBranch) {
  const mergeBase = gitOut("merge-base", `origin/${defaultBranch}`, "HEAD");
  if (mergeBase) {
    addUnique([
      ...gitZ("diff", "--name-only", "-z", "--diff-filter=ACMR", `${mergeBase}...HEAD`),
      ...gitZ("diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"),
      ...gitZ("diff", "--name-only", "-z", "--diff-filter=ACMR"),
      ...gitZ("ls-files", "--others", "--exclude-standard", "-z"),
    ]);
    diffBase = mergeBase;
    mode = `Feature branch diff (${defaultBranch}...HEAD) + uncommitted changes (staged + unstaged + untracked)`;
  } else defaultBranch = ""; // fall through to Mode B
}

if (!mode) {
  addUnique([
    ...gitZ("diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"),
    ...gitZ("diff", "--name-only", "-z", "--diff-filter=ACMR"),
    ...gitZ("ls-files", "--others", "--exclude-standard", "-z"),
  ]);
  mode = "Working directory changes (staged + unstaged + untracked)";
  if (!defaultBranch) defaultBranch = "(unknown)";
}

const emitJson = (files: string, extra = "") =>
  console.log(`{"branch":"${esc(currentBranch)}","default_branch":"${esc(defaultBranch)}","repo_root":"${esc(repoRoot)}","diff_base":"${esc(diffBase)}","mode":"${esc(mode)}","pr":"${esc(prNumber)}","pr_url":"${esc(prUrl)}","pr_title":"${esc(prTitle)}","head":"${esc(headSha)}","checkout":"${esc(checkout)}","changed_files":${files}${extra}}`);

if (!changed.length) {
  if (jsonMode) emitJson("[]", ',"message":"No changes detected. Nothing to review."');
  else console.log("No changes detected. Nothing to review.");
  process.exit(2);
}

if (jsonMode) emitJson(`[${changed.map(f => `"${esc(f)}"`).join(",")}]`);
else {
  console.log([
    `BRANCH: ${currentBranch}`, `DEFAULT_BRANCH: ${defaultBranch}`, `REPO_ROOT: ${repoRoot}`,
    `DIFF_BASE: ${diffBase}`, `MODE: ${mode}`, `PR: ${prNumber}`, `PR_URL: ${prUrl}`,
    `PR_TITLE: ${prTitle}`, `HEAD: ${headSha}`, `CHECKOUT: ${checkout}`, "CHANGED_FILES:",
    ...changed.map(f => `  ${f}`),
  ].join("\n"));
}
