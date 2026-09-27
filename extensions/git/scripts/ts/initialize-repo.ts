#!/usr/bin/env bun
// Git extension: initialize-repo.ts
// Initialize a Git repository with an initial commit. All messages go to stderr.
// Customizable: replace this script to add .gitignore templates, default branch
// config, git-flow, LFS, signing, etc.

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ignoreFeatureJson } from "./git-common.ts";

function findProjectRoot(start: string): string | null {
  for (let dir = start; dir !== "/"; dir = dirname(dir)) {
    if (existsSync(`${dir}/.specify`) || existsSync(`${dir}/.git`)) return dir;
  }
  return null;
}

function run(...cmd: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).replace(/\n+$/, "") };
}

const repoRoot = findProjectRoot(import.meta.dir) ?? process.cwd();
process.chdir(repoRoot);

let commitMsg = "[Spec Kit] Initial commit";
try {
  const msg = readFileSync(`${repoRoot}/.specify/extensions/git/git-config.yml`, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("init_commit_message:"))
    .map((l) => l.replace(/^init_commit_message:\s*/, "").replace(/^["']/, "").replace(/["']*$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
  if (msg) commitMsg = msg;
} catch {
  // no config: keep the default
}

if (!Bun.which("git")) {
  console.error("[specify] Warning: Git not found; skipped repository initialization");
  process.exit(0);
}

if (run("git", "rev-parse", "--is-inside-work-tree").ok) {
  console.error("[specify] Git repository already initialized; skipping");
  process.exit(0);
}

function step(label: string, ...cmd: string[]): void {
  const r = run(...cmd);
  if (!r.ok) {
    console.error(`[specify] Error: ${label} failed: ${r.out}`);
    process.exit(1);
  }
}

step("git init", "git", "init", "-q");
// Ignore per-worktree feature identity from the first commit (issue #33).
ignoreFeatureJson(repoRoot);
step("git add", "git", "add", ".");
step("git commit", "git", "commit", "--allow-empty", "-q", "-m", commitMsg);

console.error("✓ Git repository initialized");
