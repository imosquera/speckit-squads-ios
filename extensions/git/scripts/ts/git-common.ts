// Git extension shared library (port of git-common.ts). Import by relative path:
//   import { resolveFeature } from "../../../git/scripts/ts/git-common.ts";
//
// `.specify/feature.json` is per-worktree runtime state (gitignored). Our tooling
// reads only `source_issue` from it; every other piece of feature identity comes
// from git at call time (issue #33). `feature_directory` is written solely for core
// Spec Kit's get_feature_paths(). Core overwrites the file wholesale, so
// `source_issue` is mirrored into a sidecar in the worktree's private git dir and
// recovered from there when it goes missing (issue #78).

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

function git(cwd: string, ...args: string[]): string | null {
  if (!Bun.which("git")) return null;
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().replace(/\n+$/, "") : null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// First capture of `re` on any line (sed -nE 's/…/\1/p' | head -1). "" when none.
function firstLineMatch(text: string | null, re: RegExp): string {
  for (const line of (text ?? "").split("\n")) {
    const m = re.exec(line);
    if (m?.[1] !== undefined) return m[1];
  }
  return "";
}

/** True when `repoRoot` has a `.git` (dir or file), git is installed, and it is a work tree. */
export function hasGit(repoRoot: string = process.cwd()): boolean {
  return existsSync(`${repoRoot}/.git`) && git(repoRoot, "rev-parse", "--is-inside-work-tree") !== null;
}

/** Strip one optional prefix segment ("feat/004-name" -> "004-name"); only for exactly two segments. */
export function effectiveBranchName(raw: string): string {
  return /^[^/]+\/([^/]+)$/.exec(raw)?.[1] ?? raw;
}

/**
 * Validate a feature branch name (###-* with >=3 digits, or YYYYMMDD-HHMMSS-*).
 * Prints the bash wording to stderr; returns false only on a bad name in a git repo.
 */
export function checkFeatureBranch(raw: string, hasGitRepo: boolean): boolean {
  if (!hasGitRepo) {
    console.error("[specify] Warning: Git repository not detected; skipped branch validation");
    return true;
  }
  const b = effectiveBranchName(raw);
  const sequential = /^[0-9]{3,}-/.test(b) && !/^[0-9]{7}-[0-9]{6}-/.test(b) && !/^[0-9]{7,8}-[0-9]{6}$/.test(b);
  if (!sequential && !/^[0-9]{8}-[0-9]{6}-/.test(b)) {
    console.error(`ERROR: Not on a feature branch. Current branch: ${raw}`);
    console.error("Feature branches should be named like: 001-feature-name, 1234-feature-name, or 20260319-143022-feature-name");
    return false;
  }
  return true;
}

/** Path of the clobber-proof source_issue copy (`<git-dir>/speckit-source-issue`), or null outside git. */
export function sourceIssueSidecar(root: string = process.cwd()): string | null {
  const gitdir = git(root, "rev-parse", "--absolute-git-dir");
  return gitdir === null ? null : `${gitdir}/speckit-source-issue`;
}

/**
 * `source_issue` from `<root>/.specify/feature.json`, "" when none. When the key is
 * gone but the sidecar has it, warns on stderr, heals the file, and returns it.
 */
export function featureSourceIssue(root: string = process.cwd()): string {
  const issue = firstLineMatch(readText(`${root}/.specify/feature.json`), /.*"source_issue"\s*:\s*([0-9]+)/);
  if (issue) return issue;

  const sidecar = sourceIssueSidecar(root);
  if (sidecar === null) return "";
  const saved = firstLineMatch(readText(sidecar), /^\s*([0-9]+)/);
  if (!saved) return "";
  console.error(`[specify] Warning: .specify/feature.json lost its source_issue (#${saved});`);
  console.error(`[specify]   another writer overwrote the file. Restoring it from ${sidecar}.`);
  mergeFeatureJson(root, saved, "");
  return saved;
}

// `feature_directory` still JSON-escaped as stored, so it can be re-emitted verbatim.
function featureDirectoryRaw(root: string): string {
  return firstLineMatch(readText(`${root}/.specify/feature.json`), /.*"feature_directory"\s*:\s*"((?:[^"\\]|\\.)*)"/);
}

/** Escape backslashes and double quotes for a JSON string literal (same as the bash helper). */
export function jsonEscape(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Feature number from a branch: "014-slug" -> "014", "20260319-143022-slug" -> "20260319-143022", else "". */
export function featureNumFromBranch(branch: string): string {
  const b = effectiveBranchName(branch);
  return /^([0-9]{8}-[0-9]{6})-/.exec(b)?.[1] ?? /^([0-9]{3,})-/.exec(b)?.[1] ?? "";
}

export interface FeatureIdentity {
  /** raw current branch ("" when HEAD is unreadable) */
  branch: string;
  /** sequential/timestamp prefix, or "" */
  num: string;
  /** absolute worktree root */
  worktree: string;
  /** specs/<slug> relative to worktree, or "" when absent */
  directory: string;
  /** linked GitHub issue number, or "" */
  sourceIssue: string;
}

/**
 * Full feature identity for the worktree containing `start`; null outside a git
 * worktree. SPECIFY_FEATURE_DIRECTORY / SPECIFY_FEATURE (core overrides) win over the branch.
 */
export function resolveFeature(start: string = process.cwd()): FeatureIdentity | null {
  const worktree = git(start, "rev-parse", "--show-toplevel");
  if (worktree === null) return null;
  const branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD") ?? "";

  let directory = "";
  const envDir = process.env.SPECIFY_FEATURE_DIRECTORY;
  if (envDir) {
    directory = envDir;
  } else {
    const slug = process.env.SPECIFY_FEATURE || effectiveBranchName(branch);
    if (slug && isDir(`${worktree}/specs/${slug}`)) directory = `specs/${slug}`;
  }

  return { branch, num: featureNumFromBranch(branch), worktree, directory, sourceIssue: featureSourceIssue(worktree) };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isTracked(worktree: string, path: string): boolean {
  return git(worktree, "ls-files", "--error-unmatch", path) !== null;
}

/**
 * The only writer of `.specify/feature.json`. Merges (omitting a value keeps the
 * existing one), removes a TRACKED file first (inherited from the base branch,
 * issue #33), mirrors source_issue to the sidecar, and gitignores the file.
 * Returns false (after a stderr message) for a non-numeric source_issue.
 */
export function writeFeatureJson(worktree: string, sourceIssue = "", featureDir = ""): boolean {
  const json = `${worktree}/.specify/feature.json`;
  if (sourceIssue && !/^[0-9]+$/.test(sourceIssue)) {
    console.error(`[specify] Refusing to write a non-numeric source_issue: ${sourceIssue}`);
    return false;
  }
  mkdirSync(`${worktree}/.specify`, { recursive: true });

  if (existsSync(json)) {
    // Check trackedness before ignoreFeatureJson's `git rm --cached` hides it.
    if (isTracked(worktree, ".specify/feature.json")) {
      rmSync(json, { force: true });
      console.error("[specify] Removed inherited .specify/feature.json (it described the previous feature).");
    } else if (!sourceIssue) {
      console.error(`[specify] Kept this worktree's existing .specify/feature.json (issue #${featureSourceIssue(worktree)}); this run created no issue.`);
    }
  }

  if (sourceIssue || featureDir) mergeFeatureJson(worktree, sourceIssue, featureDir);

  const sidecar = sourceIssueSidecar(worktree);
  if (sidecar !== null) {
    if (sourceIssue) writeFileSync(sidecar, `${sourceIssue}\n`);
    // The purge above removed the linkage; the sidecar must not resurrect it.
    else if (!existsSync(json)) rmSync(sidecar, { force: true });
  }

  ignoreFeatureJson(worktree);
  return true;
}

/** Write only `feature_directory`, preserving any existing source_issue. */
export function writeFeatureDirectory(worktree: string, featureDir: string): boolean {
  return writeFeatureJson(worktree, "", featureDir);
}

// Merge keys into feature.json. A parseable file is merged as JSON (the bash jq
// path); otherwise the file is rebuilt from the line readers (the printf path).
function mergeFeatureJson(worktree: string, sourceIssue: string, featureDir: string): void {
  const json = `${worktree}/.specify/feature.json`;
  const text = readText(json);
  if (text) {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      obj = undefined;
    }
    if (obj === null || (typeof obj === "object" && !Array.isArray(obj))) {
      const merged: Record<string, unknown> = { ...(obj as Record<string, unknown> | null) };
      if (sourceIssue) merged.source_issue = Number(sourceIssue);
      if (featureDir) merged.feature_directory = featureDir;
      writeFileSync(json, `${JSON.stringify(merged)}\n`);
      return;
    }
  }

  // Read the halves this call did not supply before truncating the file.
  const issue = sourceIssue || featureSourceIssue(worktree);
  const dirJson = featureDir ? jsonEscape(featureDir) : featureDirectoryRaw(worktree);
  const parts: string[] = [];
  if (issue) parts.push(`"source_issue":${issue}`);
  if (dirJson) parts.push(`"feature_directory":"${dirJson}"`);
  writeFileSync(json, `{${parts.join(",")}}\n`);
}

/** Gitignore `.specify/feature.json` and untrack it if an older layout committed it. Idempotent. */
export function ignoreFeatureJson(worktree: string): void {
  const gitignore = `${worktree}/.gitignore`;
  const pattern = ".specify/feature.json";
  const current = readText(gitignore);

  if (!(current ?? "").split("\n").includes(pattern)) {
    const sep = current && !current.endsWith("\n") ? "\n" : "";
    appendFileSync(gitignore, `${sep}# Per-worktree feature identity (regenerated by /speckit-git-feature).\n${pattern}\n`);
  }

  if (isTracked(worktree, pattern)) {
    git(worktree, "rm", "--cached", "-q", pattern);
    console.error(`[specify] Untracked ${pattern} (it is per-worktree state, not project config; see issue #33).`);
    console.error("[specify]   The removal is staged in this worktree and lands when this feature merges.");
  }
}

/**
 * `commit_exclude:` paths from `<root>/.specify/extensions/git/git-config.yml`
 * (generated artifacts the auto-commit flow must never stage, issue #22).
 * Root defaults to the cwd's git toplevel. [] when there is no config.
 */
export function commitExcludes(root?: string): string[] {
  const r = root ?? git(process.cwd(), "rev-parse", "--show-toplevel") ?? "";
  const cfg = readText(`${r}/.specify/extensions/git/git-config.yml`);
  if (cfg === null) return [];

  const out: string[] = [];
  let inList = false;
  for (const line of cfg.split("\n")) {
    if (/^\s*commit_exclude:\s*$/.test(line)) {
      inList = true;
    } else if (inList && /^\s*-\s*/.test(line)) {
      const item = line
        .replace(/^\s*-\s*/, "")
        .replace(/\s*#.*$/, "")
        .replace(/^["']|["']$/g, "")
        .replace(/\s+$/, "");
      if (item) out.push(item);
    } else if (inList && /^\s*[^\s-]/.test(line)) {
      inList = false;
    }
  }
  return out;
}
