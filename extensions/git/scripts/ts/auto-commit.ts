#!/usr/bin/env bun
// git extension: auto-commit.ts
// Commit changes after a Spec Kit command completes, per the auto_commit
// section of git-config.yml. commit_exclude paths are held out of the commit
// (issue #22) but not scrubbed: that threw away graph rebuilds between phases
// (issue #109). create-pr.ts and clean.ts still scrub. Untracked Xcode build output
// and per-user state (DerivedData/, xcuserdata/, *.xcresult, ... see XCODE_ARTIFACTS)
// is held out the same way, whether or not the project's .gitignore covers it.
//
// Usage: auto-commit.ts <event_name>     e.g. auto-commit.ts after_specify
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { commitExcludes, featureSourceIssue, pendingXcodeArtifacts } from "./git-common.ts";

const event = process.argv[2] ?? "";
if (!event) {
  console.error(`Usage: ${process.argv[1]} <event_name>`);
  process.exit(1);
}

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

const root = findProjectRoot(import.meta.dir) ?? process.cwd();
process.chdir(root);

function git(...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).replace(/\n+$/, "") };
}

if (!Bun.which("git")) {
  console.error("[specify] Warning: Git not found; skipped auto-commit");
  process.exit(0);
}
if (!git("rev-parse", "--is-inside-work-tree").ok) {
  console.error("[specify] Warning: Not a Git repository; skipped auto-commit");
  process.exit(0);
}

let cfg: string;
try {
  cfg = readFileSync(`${root}/.specify/extensions/git/git-config.yml`, "utf8");
} catch {
  process.exit(0); // no config: auto-commit disabled
}

const esc = event.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const scalar = (line: string) => line.replace(/^[^:]*:\s*/, "").replace(/\s/g, "").toLowerCase();
let enabled = false;
let message = "";
let inAuto = false;
let inEvent = false;
let defaultEnabled = false;
// `while read` drops a final line with no trailing newline; so do we.
const cfgLines = cfg.split("\n").slice(0, -1);
for (const line of cfgLines) {
  if (/^auto_commit:/.test(line)) {
    inAuto = true;
    inEvent = false;
    continue;
  }
  if (inAuto && /^[a-z]/.test(line)) break;
  if (!inAuto) continue;
  if (/^\s+default:\s/.test(line) && scalar(line) === "true") defaultEnabled = true;
  if (new RegExp(`^\\s+${esc}:`).test(line)) {
    inEvent = true;
    continue;
  }
  if (inEvent) {
    if (/^\s{2}[a-z]/.test(line) && !/^\s{4}/.test(line)) {
      inEvent = false;
      continue;
    }
    if (/\s+enabled:/.test(line)) {
      const v = scalar(line);
      if (v === "true") enabled = true;
      if (v === "false") enabled = false;
    }
    if (/\s+message:/.test(line)) {
      message = line.replace(/^[^:]*:\s*/, "").replace(/^["']/, "").replace(/["']*$/, "");
    }
  }
}
// The default applies only when the event has no section of its own.
if (!enabled && defaultEnabled && !new RegExp(`^\\s*${esc}:`, "m").test(cfg)) enabled = true;
if (!enabled) process.exit(0);

if (git("diff", "--quiet", "HEAD").ok && git("diff", "--cached", "--quiet").ok && !git("ls-files", "--others", "--exclude-standard").out) {
  console.error(`[specify] No changes to commit after ${event}`);
  process.exit(0);
}

const command = event.replace(/^after_/, "").replace(/^before_/, "");
const phase = event.startsWith("before_") ? "before" : "after";
message ||= `[Spec Kit] Auto-commit ${phase} ${command}`;

// `Closes #N` on after_* only; a before_* commit is a checkpoint. featureSourceIssue
// also heals a feature.json that core's setup-plan overwrote (issue #78).
if (phase === "after") {
  const issue = featureSourceIssue(root);
  if (/^[0-9]+$/.test(issue) && !new RegExp(`(closes|fixes|resolves)\\s+#${issue}\\b`, "i").test(message)) {
    message = `${message}\n\nCloses #${issue}`;
  }
}

const excludes = commitExcludes(root);
const artifacts = pendingXcodeArtifacts(root);
for (const e of excludes) git("reset", "-q", "--", e); // unstage anything already staged
for (const a of artifacts) git("reset", "-q", "--", `:(literal)${a}`);
const add = git("add", "--", ".", ...excludes.map((e) => `:(exclude)${e}`), ...artifacts.map((a) => `:(exclude,literal)${a}`));
if (!add.ok) {
  console.error(`[specify] Error: git add failed: ${add.out}`);
  process.exit(1);
}
if (git("diff", "--cached", "--quiet").ok) {
  const held = [...excludes, ...artifacts];
  console.error(`[specify] Nothing to commit after ${event} — all changes are in excluded paths (${held.join(", ") || "none"})`);
  process.exit(0);
}
const commit = git("commit", "-q", "-m", message);
if (!commit.ok) {
  console.error(`[specify] Error: git commit failed: ${commit.out}`);
  process.exit(1);
}
if (excludes.length) console.error(`[specify] Held out of the commit: ${excludes.join(", ")}`);
if (artifacts.length) console.error(`[specify] Held out Xcode build/user state (add it to .gitignore): ${artifacts.join(", ")}`);
console.error(`[OK] Changes committed ${phase} ${command}`);
