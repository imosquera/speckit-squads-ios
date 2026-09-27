#!/usr/bin/env bun
// Do the files this issue asks us to change live in the repo this run is bound to?
// Usage: check-target-repo.ts [--repo-root <dir>] <path>...
//        check-target-repo.ts [--repo-root <dir>] --kind
// Prints INSIDE:/FOREIGN:/OUTSIDE: per target, then the repo's iOS target and a
// verdict the skill reads:
//   KIND: workspace|project|package <relpath>   or   KIND: none
//   OK: N target(s) inside <repo>           exit 0
//   BLOCKED: N of N target(s) not in <repo>  exit 1   (usage/env errors: exit 2)
// Repo identity is the git COMMON dir, not the toplevel: autopilot runs in a
// worktree, whose toplevel differs from the main repo's (issue #34).
//
// `--kind` prints only the KIND line (exit 0 when an iOS target was found, 1 for
// `none`), which is how the skill picks `xcodebuild -workspace`/`-project` vs
// `swift build`/`swift test` for its gates. Preference: an .xcworkspace (it carries
// the SPM/CocoaPods wiring) over an .xcodeproj over a Package.swift; shallowest
// first, then by name. Bundles are not descended into, so the .xcworkspace every
// .xcodeproj embeds never counts, and build/vendor dirs are skipped.

import { dirname, join, relative } from "node:path";
import { readdirSync, statSync } from "node:fs";

const RESOLVE = join(import.meta.dir, "resolve-path.ts");

function git(dir: string, ...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().replace(/\n+$/, "") };
}
const repoId = (dir: string) => git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir").out;
const toplevel = (dir: string, fallback: string) => {
  const r = git(dir, "rev-parse", "--show-toplevel");
  return r.ok ? r.out : fallback;
};
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

type Kind = { kind: "workspace" | "project" | "package"; path: string } | null;
const SKIP_DIRS = new Set([".git", ".build", ".swiftpm", "build", "DerivedData", "Pods", "Carthage", "node_modules", "vendor"]);
const RANK = { workspace: 0, project: 1, package: 2 } as const;

/** The repo's iOS target, searched to depth 3 below `root`. */
function detectKind(root: string, maxDepth = 3): Kind {
  const found: { kind: keyof typeof RANK; path: string; depth: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.endsWith(".xcworkspace")) found.push({ kind: "workspace", path: p, depth });
        else if (e.name.endsWith(".xcodeproj")) found.push({ kind: "project", path: p, depth });
        else if (depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(p, depth + 1);
      } else if (e.name === "Package.swift") found.push({ kind: "package", path: p, depth });
    }
  };
  walk(root, 0);
  found.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.depth - b.depth || a.path.localeCompare(b.path));
  const best = found[0];
  return best ? { kind: best.kind, path: relative(root, best.path) } : null;
}
const kindLine = (k: Kind) => (k ? `KIND: ${k.kind} ${k.path}` : "KIND: none");

const args = process.argv.slice(2);
let repoRoot = "";
while (args[0] === "--repo-root") {
  if (!args[1]) {
    process.stderr.write("[autopilot] Error: --repo-root needs a path\n");
    process.exit(1);
  }
  repoRoot = args[1];
  args.splice(0, 2);
}

const kindOnly = args[0] === "--kind";
if (kindOnly) {
  const k = detectKind(toplevel(repoRoot || process.cwd(), repoRoot || process.cwd()));
  console.log(kindLine(k));
  process.exit(k ? 0 : 1);
}

if (args.length === 0) {
  process.stderr.write("[autopilot] Usage: check-target-repo.ts [--repo-root <dir>] <path>... | --kind\n");
  process.exit(2);
}
if (!Bun.which("git")) {
  process.stderr.write("[autopilot] Error: git not found\n");
  process.exit(2);
}

const oursDir = repoRoot || process.cwd();
const ours = repoId(oursDir);
if (!ours) {
  process.stderr.write(`[autopilot] Error: ${oursDir} is not inside a git repository\n`);
  process.exit(2);
}
const oursName = toplevel(oursDir, oursDir);

let bad = 0;
for (const target of args) {
  // resolve-path.ts: ~ and symlinks resolved; a not-yet-existing file maps to its
  // deepest existing ancestor, the directory it would be created in.
  const r = Bun.spawnSync([process.execPath, RESOLVE, target], { stdout: "pipe", stderr: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode);
  const real = r.stdout.toString().replace(/\n+$/, "");
  const probe = isDir(real) ? real : dirname(real);

  const theirs = repoId(probe);
  if (!theirs) {
    console.log(`OUTSIDE: ${target} → no git repo`);
    bad++;
  } else if (theirs === ours) {
    console.log(`INSIDE: ${target} → ${oursName}`);
  } else {
    console.log(`FOREIGN: ${target} → ${toplevel(probe, theirs)}`);
    bad++;
  }
}

console.log(kindLine(detectKind(oursName)));

if (bad === 0) {
  console.log(`OK: ${args.length} target(s) inside ${oursName}`);
  process.exit(0);
}
console.log(`BLOCKED: ${bad} of ${args.length} target(s) not in ${oursName}`);
process.exit(1);
