#!/usr/bin/env bun
// Bind a worktree to an existing GitHub issue by writing `.specify/feature.json`.
//
// Usage: bind-feature-issue.ts <issue-number> [worktree-path]
//
// Goes through the git extension's shared writer, never a raw write: the writer
// also gitignores the file and untracks a committed copy, so it cannot leak into
// the next worktree (issues #21, #33).
import { existsSync } from "node:fs";
import { basename } from "node:path";

type GitCommon = typeof import("../../../git/scripts/ts/git-common.ts");

function die(...lines: string[]): never {
  for (const l of lines) console.error(l);
  process.exit(1);
}

const issue = process.argv[2] ?? "";
let worktree = process.argv[3] || process.cwd();

if (!issue) die(`Usage: ${basename(process.argv[1] ?? "bind-feature-issue.ts")} <issue-number> [worktree-path]`);
if (!/^[0-9]+$/.test(issue)) die(`[autopilot] Issue number must be numeric, got: ${issue}`);

const git = (...a: string[]) => Bun.spawnSync(["git", "-C", worktree, ...a], { stdout: "pipe", stderr: "ignore" });
if (git("rev-parse", "--is-inside-work-tree").exitCode !== 0) die(`[autopilot] Not a git worktree: ${worktree}`);
// Normalize to the top level so `.specify/` and `.gitignore` land there.
worktree = git("rev-parse", "--show-toplevel").stdout.toString().replace(/\n+$/, "");

const gitCommon = [
  `${import.meta.dir}/../../../git/scripts/ts/git-common.ts`,
  `${worktree}/.specify/extensions/git/scripts/ts/git-common.ts`,
  `${process.env.CLAUDE_PROJECT_DIR ?? ""}/.specify/extensions/git/scripts/ts/git-common.ts`,
].find((c) => existsSync(c));
if (!gitCommon)
  die(
    "[autopilot] Could not locate the git extension's git-common.ts.",
    "[autopilot] The git extension is required — install it with:",
    "[autopilot]   specify extension add git",
  );

const { writeFeatureJson } = (await import(gitCommon)) as GitCommon;
if (!writeFeatureJson(worktree, issue)) process.exit(1);

console.log(`[autopilot] Bound ${worktree} to issue #${issue} (.specify/feature.json, gitignored).`);
