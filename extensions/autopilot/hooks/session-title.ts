#!/usr/bin/env bun
// Claude Code SessionStart hook: title the session "#N: <issue title>" (from
// .specify/feature.json source_issue + gh), else the git branch. Registered in
// the consumer's .claude/settings.json (see README). Only startup/resume, since
// Claude ignores sessionTitle after /clear and compaction. Never errors: a
// broken hook must not block a session from starting.

import { readFileSync } from "node:fs";

function sh(argv: string[], opts: { cwd?: string; timeout?: number } = {}): string {
  try {
    const r = Bun.spawnSync(argv, { ...opts, stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().replace(/\n+$/, "") : "";
  } catch {
    return "";
  }
}
const branchOf = (args: string[]) => {
  const b = sh(["git", ...args, "rev-parse", "--abbrev-ref", "HEAD"]);
  return b === "HEAD" ? "" : b;
};

let input: { source?: unknown; cwd?: unknown };
try {
  input = JSON.parse(await Bun.stdin.text()) ?? {};
} catch {
  process.exit(0);
}
if (input.source !== "startup" && input.source !== "resume") process.exit(0);

const cwd = typeof input.cwd === "string" ? input.cwd : "";
if (cwd) try { process.chdir(cwd); } catch { /* stay put */ }

// The repo root, so .specify/ is found from a subdir of the worktree.
const root = sh(["git", "rev-parse", "--show-toplevel"]) || cwd;
const featureJson = `${root}/.specify/feature.json`;

// The live branch is authoritative; feature.json contributes only the issue
// number (its old branch_name named the previous feature — issue #33).
const branch = branchOf(["-C", root]);

let issue = "";
try {
  const v = JSON.parse(readFileSync(featureJson, "utf8")).source_issue;
  if (v !== null && v !== undefined && v !== false) issue = typeof v === "string" ? v : JSON.stringify(v);
} catch { /* no feature.json */ }

let title = "";
if (issue && Bun.which("gh")) {
  // Time-boxed so a slow or unauthed gh never stalls session start.
  const ititle = sh(["gh", "issue", "view", issue, "--json", "title", "-q", ".title"], { cwd: root, timeout: 5000 });
  title = ititle ? `#${issue}: ${ititle}` : `#${issue}${branch ? `: ${branch}` : ""}`;
} else if (branch) {
  title = branch;
}
if (!title) title = branchOf([]);

// Nothing worth setting (main checkout, no feature): stay silent.
if (!title) process.exit(0);

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", sessionTitle: title } }, null, 2) + "\n");
