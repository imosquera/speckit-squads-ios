#!/usr/bin/env bun
// stale-tasks-guard.ts — deterministic helper for the stale-tasks-guard extension.
//
// Compares spec.md/tasks.md staleness for the active feature directory, resolved
// with the same priority core Spec Kit uses (.specify/scripts/bash/common.sh
// get_feature_paths()): the SPECIFY_FEATURE_DIRECTORY env var first (an explicit
// override for the run), then SPECIFY_FEATURE, then the current git branch name.
// `.specify/feature.json` is not consulted: the only key of ours in it is
// `source_issue`, and its "feature_directory" key is written solely for core Spec
// Kit's own get_feature_paths(). We never resolve a path from that file — back when
// it was tracked, the recorded directory named the *previous* feature in any fresh
// worktree (issue #33). A clean (committed, non-dirty) file's git commit time is
// used instead of its filesystem mtime, since `git checkout`/clone resets mtimes
// for every file to checkout time regardless of true edit history — which would
// otherwise silently defeat the comparison in a fresh worktree. A file with
// uncommitted local changes uses its filesystem mtime, which reflects the real
// edit time.
//
// Exit codes:
//   0   Not stale, or the guard does not apply (missing spec.md/tasks.md,
//       unresolvable feature directory). Implementation may proceed.
//   1   Stale tasks detected: spec.md is newer than tasks.md.
//
// Jev assist: before exiting 1, the spec.md diff since tasks.md's last commit is
// handed to the sibling jev.ts (`spec-change`). Only a confident `wording`
// verdict turns the halt into exit 0 (with an advisory on stderr). Dirty or
// uncommitted tasks.md, no git, an empty diff, SPECKIT_JEV=off, or any Jev
// failure leaves the halt exactly as it was.
//
// Anything printed to stderr on a 0 exit is advisory (e.g. "guard skipped —
// feature directory unresolvable") and must not be read as staleness.

import { statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

function git(args: string[], cwd: string): string | null {
  try {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: 5000 });
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim();
  } catch {
    return null;
  }
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// Uncommitted changes: filesystem mtime (accurate). Clean/committed file: the
// file's last commit time (immune to checkout resetting mtime). Not a git repo,
// or file untracked: filesystem mtime.
function effectiveMtime(path: string): number {
  const dirty = git(["status", "--porcelain", "--", path], ".");
  if (!dirty) {
    const commitEpoch = git(["log", "-1", "--format=%ct", "--", path], ".");
    if (commitEpoch) return Number(commitEpoch);
  }
  return statSync(path).mtimeMs / 1000;
}

// spec.md's diff since the commit that last wrote tasks.md, uncommitted edits
// included. null when no trustworthy diff exists: no git, tasks.md dirty or
// never committed, spec.md untracked, or the diff is empty.
function specDiffSinceTasks(specPath: string, tasksPath: string): string | null {
  if (git(["status", "--porcelain", "--", tasksPath], ".") !== "") return null;
  if (git(["ls-files", "--error-unmatch", "--", specPath], ".") === null) return null;
  const commit = git(["log", "-1", "--format=%H", "--", tasksPath], ".");
  if (!commit) return null;
  try {
    const r = Bun.spawnSync(["git", "diff", commit, "--", specPath], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
    if (r.exitCode !== 0) return null;
    const diff = r.stdout.toString();
    return diff.trim() ? diff : null;
  } catch {
    return null;
  }
}

type Jev = { code: number; decision: string | null; source: string | null; record: string | null };

// Any failure (spawn error, timeout, unparseable output) is { code: -1 }, which
// the caller treats exactly like "no Jev".
function askJev(diff: string): Jev {
  const none: Jev = { code: -1, decision: null, source: null, record: null };
  try {
    const script = join(dirname(import.meta.path), "jev.ts");
    if (!isFile(script)) return none;
    const r = Bun.spawnSync([process.execPath, script, "spec-change", "--diff", "-"], {
      stdin: Buffer.from(diff), stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    const line = r.stdout.toString().trim().split("\n").pop() ?? "";
    const out = JSON.parse(line) as { decision?: unknown; source?: unknown; record?: unknown };
    return {
      code: r.exitCode ?? -1,
      decision: typeof out.decision === "string" ? out.decision : null,
      source: typeof out.source === "string" ? out.source : null,
      record: typeof out.record === "string" ? out.record : null,
    };
  } catch {
    return none;
  }
}

// The branch is the authoritative source, matching spec_kit_resolve_feature in
// the git extension's git-common.ts; `.specify/feature.json` is deliberately
// NOT consulted (issue #33).
function resolveFeatureDir(): string | null {
  const envDir = process.env.SPECIFY_FEATURE_DIRECTORY;
  if (envDir) return isAbsolute(envDir) ? envDir : join(process.cwd(), envDir);

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], ".") ?? "";
  const slug = process.env.SPECIFY_FEATURE || branch.slice(branch.lastIndexOf("/") + 1);

  if (slug && slug !== "HEAD") {
    const candidate = join("specs", slug);
    if (isDir(candidate)) return candidate;
  }

  process.stderr.write(
    `stale-tasks-guard: could not resolve a feature directory for ${slug || "<unknown branch>"}; skipping guard\n`,
  );
  return null;
}

function main(): number {
  const featureDir = resolveFeatureDir();
  if (featureDir === null) return 0;

  const specPath = join(featureDir, "spec.md");
  const tasksPath = join(featureDir, "tasks.md");
  if (!isFile(specPath) || !isFile(tasksPath)) return 0;

  const specTime = effectiveMtime(specPath);
  const tasksTime = effectiveMtime(tasksPath);

  if (specTime > tasksTime) {
    const deltaMinutes = Math.trunc((specTime - tasksTime) / 60);
    const diff = specDiffSinceTasks(specPath, tasksPath);
    const jev = diff === null ? null : askJev(diff);
    if (jev?.code === 0 && jev.decision === "wording") {
      process.stderr.write(
        `stale-tasks-guard: spec.md changed after tasks.md, but only in wording — proceeding (${jev.record ?? "jev spec-change"})\n`,
      );
      return 0;
    }
    console.log("STALE TASKS DETECTED");
    console.log(`   spec.md was modified ${deltaMinutes}m after tasks.md was last generated.`);
    console.log("   Run /speckit-tasks to reconcile, then re-run /speckit-implement.");
    console.log("   To bypass: /speckit-implement --force");
    if (jev?.source === "jev" && jev.record) console.log(`   ${jev.record}`);
    return 1;
  }
  return 0;
}

process.exit(main());
