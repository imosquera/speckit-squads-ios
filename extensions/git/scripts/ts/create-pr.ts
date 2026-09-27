#!/usr/bin/env bun
// git extension: create-pr.ts
// Open a GitHub PR for the current feature branch. With a source_issue in
// .specify/feature.json the title is prefixed `#N: `, the body carries
// `Closes #N`, and the issue's labels (minus autopilot:*) are copied onto the
// PR unless `pr_copy_labels: false`.
//
// Usage: create-pr.ts [base_branch] [--draft]
//   base_branch defaults to "main". --draft opens it as a draft directly
//   (gh pr create --draft), never create-then-convert (issue #28).
// Status lines go to stderr; stdout stays empty.
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { commitExcludes, resolveFeature, sourceIssueSidecar } from "./git-common.ts";

let baseBranch = "";
let draft = false;
for (const a of process.argv.slice(2)) {
  if (a === "--draft") draft = true;
  else if (a.startsWith("-")) {
    console.error(`[specify] Error: unknown option: ${a}`);
    console.error("[specify] Usage: create-pr.ts [base_branch] [--draft]");
    process.exit(1);
  } else {
    if (baseBranch) {
      console.error(`[specify] Error: unexpected argument: ${a}`);
      process.exit(1);
    }
    baseBranch = a;
  }
}
baseBranch ||= "main";

const stat = (p: string) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};
const readText = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
function findProjectRoot(dir: string): string | null {
  for (; dir !== "/"; dir = dirname(dir)) {
    if (stat(`${dir}/.specify`)?.isDirectory() || stat(`${dir}/.git`)?.isDirectory()) return dir;
  }
  return null;
}

const root = findProjectRoot(import.meta.dir) ?? process.cwd();
process.chdir(root);

type Run = { ok: boolean; out: string; both: string };
function run(cmd: string[]): Run {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString().replace(/\n+$/, "");
  return { ok: r.exitCode === 0, out, both: (r.stdout.toString() + r.stderr.toString()).replace(/\n+$/, "") };
}
const git = (...args: string[]) => run(["git", ...args]);
const gh = (...args: string[]) => run(["gh", ...args]);
// A step bash ran under `set -e`: output shown (stdout optionally hidden), failure aborts.
function must(cmd: string[], stdout: "inherit" | "ignore" | "pipe" = "inherit"): string {
  const r = Bun.spawnSync(cmd, { stdout, stderr: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
  return stdout === "pipe" ? (r.stdout?.toString() ?? "").replace(/\n+$/, "") : "";
}

if (!Bun.which("git")) {
  console.error("[specify] Error: git not found");
  process.exit(1);
}
if (!Bun.which("gh")) {
  console.error("[specify] Error: gh CLI not found; install https://cli.github.com/");
  process.exit(1);
}
if (!git("rev-parse", "--is-inside-work-tree").ok) {
  console.error("[specify] Error: not inside a git repository");
  process.exit(1);
}

const currentBranch = must(["git", "rev-parse", "--abbrev-ref", "HEAD"], "pipe");
if (currentBranch === baseBranch) {
  console.error(`[specify] Error: refuse to open a PR from ${baseBranch} into itself`);
  process.exit(1);
}

// Directory derived from the branch; only source_issue is read from feature.json.
const feature = resolveFeature(root);
const featureDir = feature?.directory ?? "";
const sourceIssue = feature?.sourceIssue ?? "";
const hasIssue = /^[0-9]+$/.test(sourceIssue);

// Linked at creation but source_issue unrecoverable now: refuse a PR that closes nothing (issue #78).
if (!hasIssue) {
  const sidecar = sourceIssueSidecar(root);
  const saved = sidecar !== null && (stat(sidecar)?.size ?? 0) > 0 ? (readText(sidecar) ?? "").replace(/\n+$/, "") : "";
  if (saved) {
    console.error(`[specify] Error: this worktree was linked to issue #${saved} at creation,`);
    console.error("[specify]   but .specify/feature.json no longer carries source_issue and it could not");
    console.error("[specify]   be recovered. Refusing to open a PR that closes nothing.");
    process.exit(1);
  }
}

let title = "";
if (featureDir) {
  const spec = readText(`${root}/${featureDir}/spec.md`);
  const h1 = spec?.split("\n").find((l) => /^#\s*Feature Specification:/.test(l));
  if (h1) title = h1.replace(/^#\s*Feature Specification:\s*/, "");
}
title ||= currentBranch;
// Prefix, not a trailing `(#N)`: GitHub appends `(#<pr>)` on squash. Never double-prefix.
if (hasIssue && !new RegExp(`^#${sourceIssue}([^0-9]|$)`).test(title)) title = `#${sourceIssue}: ${title}`;

let body = featureDir
  ? `Spec: \`${featureDir}/spec.md\`\n\nSee plan, tasks, and quickstart under \`${featureDir}/\`.`
  : `See branch \`${currentBranch}\`.`;
if (hasIssue) body += `\n\nCloses #${sourceIssue}`;

const configText = readText(`${root}/.specify/extensions/git/git-config.yml`);
// One scalar from git-config.yml, whitespace-stripped and lowercased; "" when absent.
function configScalar(key: string): string {
  const line = configText?.split("\n").find((l) => new RegExp(`^\\s*${key}:`).test(l));
  return line ? line.replace(new RegExp(`^\\s*${key}:\\s*`), "").replace(/\s/g, "").toLowerCase() : "";
}
const squash = configScalar("squash_before_pr") === "true";
const copyLabels = configScalar("pr_copy_labels") !== "false";

// Labels go on after the PR exists: `gh pr create --label` rejects the whole
// create over one unknown label. autopilot:* is picker run-state, not a description.
function syncPrLabels(pr: string): void {
  if (!copyLabels || !hasIssue) return;
  const labels = gh("issue", "view", sourceIssue, "--json", "labels", "-q", ".labels[].name")
    .out.split("\n")
    .filter((l) => l && !l.startsWith("autopilot:"));
  if (labels.length === 0) return;
  const r = gh("pr", "edit", pr, ...labels.flatMap((l) => ["--add-label", l]));
  if (r.ok) console.error(`[specify] Copied ${labels.length} label(s) from #${sourceIssue} to the PR`);
  else console.error(`[specify] Warning: could not copy labels from #${sourceIssue}: ${r.both}`);
}

// Provenance footer, read from the environment (never agent-supplied); off with pr_session_footer: false.
const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? "";
if (configScalar("pr_session_footer") !== "false" && sessionId) {
  let who = git("config", "user.name").out;
  const email = git("config", "user.email").out;
  if (email) who = `${who ? `${who} ` : ""}<${email}>`;
  body += `\n\n---\n\n<!-- speckit:agent-session -->\n**Agent session** — resume this work locally:\n\n\`\`\`\nclaude --resume ${sessionId}\n\`\`\`\n`;
  if (who) body += `\n- Author: ${who}`;
  const bridge = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID ?? "";
  if (bridge) body += `\n- Web: https://claude.ai/code/${bridge}`;
}

function ensureBaseLocal(): boolean {
  if (git("rev-parse", "--verify", baseBranch).ok) return true;
  if (!git("ls-remote", "--exit-code", "--heads", "origin", baseBranch).ok) return false;
  return git("fetch", "origin", `${baseBranch}:${baseBranch}`).ok || git("fetch", "origin", baseBranch).ok;
}

// (a) Working tree: the shared handler (issues #55, #62).
Bun.spawnSync([process.execPath, `${import.meta.dir}/scrub-commit-exclude.ts`, "--repo", root], { stdout: "inherit", stderr: "inherit" });

// (b) History: an excluded path committed on the branch is reset to the base,
// removed from the index first so branch-ADDED files under it go too.
{
  const baseOk = ensureBaseLocal();
  let resetAny = false;
  for (const ex of commitExcludes(root)) {
    if (baseOk && !git("diff", "--quiet", `${baseBranch}...HEAD`, "--", ex).ok) {
      console.error(`[specify] Excluded artifact diverges from ${baseBranch}; resetting: ${ex}`);
      git("rm", "-rq", "--cached", "--ignore-unmatch", "--", ex);
      git("checkout", baseBranch, "--", ex);
      resetAny = true;
    }
  }
  if (resetAny && !git("diff", "--cached", "--quiet").ok) {
    if (!git("commit", "-q", "-m", `chore: reset excluded generated artifacts to ${baseBranch}`).ok) {
      console.error("[specify] Warning: could not commit the artifact reset");
    }
  }
}

if (squash) {
  ensureBaseLocal();
  let mb = git("merge-base", "HEAD", baseBranch);
  if (!mb.ok) mb = git("merge-base", "HEAD", `origin/${baseBranch}`);
  const mergeBase = mb.ok ? mb.out : "";
  if (!mergeBase) {
    console.error(`[specify] Error: cannot compute merge-base with ${baseBranch}; aborting squash`);
    process.exit(1);
  }
  const count = Number(git("rev-list", "--count", `${mergeBase}..HEAD`).out) || 0;
  if (count > 1) {
    if (!git("diff-index", "--quiet", "HEAD").ok || !git("diff", "--cached", "--quiet").ok) {
      console.error("[specify] Error: working tree has uncommitted changes; commit or stash before squashing");
      process.exit(1);
    }
    console.error(`[specify] Squashing ${count} commits into one...`);
    let squashBody = git("log", "--reverse", "--format=- %s", `${mergeBase}..HEAD`).out;
    if (hasIssue) squashBody += `\n\nCloses #${sourceIssue}`;
    must(["git", "reset", "--soft", mergeBase]);
    must(["git", "commit", "-q", "-m", title, "-m", squashBody]);
  } else if (count === 0) {
    console.error(`[specify] Warning: no commits between ${baseBranch} and HEAD; nothing to squash`);
  }
}

// Push (force-with-lease only when we squashed an already-pushed branch).
if (!git("ls-remote", "--exit-code", "--heads", "origin", currentBranch).ok) {
  console.error(`[specify] Pushing ${currentBranch} to origin...`);
  must(["git", "push", "-u", "origin", currentBranch], "ignore");
} else if (squash) {
  console.error(`[specify] Force-pushing squashed ${currentBranch} to origin...`);
  must(["git", "push", "--force-with-lease", "origin", currentBranch], "ignore");
}

if (gh("pr", "view", currentBranch).ok) {
  const url = gh("pr", "view", currentBranch, "--json", "url", "-q", ".url").out;
  if (draft && gh("pr", "view", currentBranch, "--json", "isDraft", "-q", ".isDraft").out === "false") {
    console.error(`[specify] Warning: existing PR is not a draft; convert it with \`gh pr ready ${url} --undo\``);
  }
  syncPrLabels(currentBranch);
  console.error(`[OK] PR already exists: ${url}`);
  process.exit(0);
}

const args = ["gh", "pr", "create", "--base", baseBranch, "--head", currentBranch, "--title", title, "--body", body];
if (draft) args.push("--draft");
const url = must(args, "pipe");
syncPrLabels(currentBranch);
console.error(draft ? `[OK] Draft PR created: ${url}` : `[OK] PR created: ${url}`);
