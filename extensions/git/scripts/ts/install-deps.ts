#!/usr/bin/env bun
// Git extension: install-deps.ts — install a fresh linked worktree's dependencies (issue #51).
//
// iOS projects: CocoaPods (Podfile.lock), Carthage (Cartfile.resolved), a Swift package
// (Package.swift) and an Xcode app's SwiftPM dependencies (Package.resolved inside its
// .xcodeproj / .xcworkspace). Where the dependencies live in the checkout, the base
// checkout is the oracle: Pods/ and Carthage/Build/ are installed here only if the base
// has them (and they are not committed); a package is resolved when its Package.resolved
// is tracked or the base has .build/. xcodebuild keeps packages in DerivedData keyed by
// the checkout path, so a tracked app Package.resolved is always resolved. Mintfile and
// Brewfile are left alone (machine-wide tools, not per-checkout). A missing tool is named
// and skipped. Best effort: every path exits 0.
//
// Usage: install-deps.ts <worktree-path>     Env: SPECKIT_SKIP_INSTALL=1 skips entirely

import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const say = (s: string) => console.error(`[specify] install-deps: ${s}`);
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const arg = process.argv[2] ?? "";
if (!arg || !isDir(arg)) {
  say(`no such worktree '${arg}'; skipping dependency install`);
  process.exit(0);
}
if (process.env.SPECKIT_SKIP_INSTALL === "1") {
  say("SPECKIT_SKIP_INSTALL=1; skipping dependency install");
  process.exit(0);
}
const WT = resolve(arg);

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", WT, ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString() : "";
}

// Base checkout = the main worktree. Everything after "worktree " (paths may hold spaces).
const first = git("worktree", "list", "--porcelain", "-z").split("\0")[0] || git("worktree", "list", "--porcelain").split("\n")[0] || "";
const BASE = first.startsWith("worktree ") ? first.slice(9) : "";
if (!BASE || !isDir(BASE)) {
  say("could not resolve the base checkout; skipping dependency install");
  process.exit(0);
}
// Physical paths: git reports /private/var/..., the caller usually passes /var/....
if (realpathSync(BASE) === realpathSync(WT)) process.exit(0); // not a linked worktree

// ---- discovery: tracked iOS dependency manifests, grouped by directory ("." for the root)
const dirOf = (f: string) => f.replace(/[^/]+$/, "").replace(/\/$/, "") || ".";
const tracked = git("ls-files").split("\n").filter(Boolean);
type Dir = { spm?: boolean; spmResolved?: boolean; pods?: boolean; carthage?: boolean; containers: Set<string> };
const dirs = new Map<string, Dir>();
const at = (rel: string) => dirs.get(rel) ?? (dirs.set(rel, { containers: new Set() }), dirs.get(rel)!);
for (const f of tracked) {
  const base = f.slice(f.lastIndexOf("/") + 1);
  // An app's SwiftPM lockfile lives inside its container:
  //   App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
  //   App.xcworkspace/xcshareddata/swiftpm/Package.resolved
  const segs = f.split("/");
  const k = segs.findIndex((g) => /\.(xcodeproj|xcworkspace)$/.test(g));
  const tail = k < 0 ? "" : segs.slice(k + 1).join("/");
  const app = k >= 0 && (tail === "xcshareddata/swiftpm/Package.resolved" || (segs[k]!.endsWith(".xcodeproj") && tail === "project.xcworkspace/xcshareddata/swiftpm/Package.resolved"));
  if (app) at(segs.slice(0, k).join("/") || ".").containers.add(segs[k]!);
  else if (base === "Package.swift") at(dirOf(f)).spm = true;
  else if (base === "Package.resolved") at(dirOf(f)).spmResolved = true;
  else if (base === "Podfile.lock") at(dirOf(f)).pods = true;
  else if (base === "Cartfile.resolved") at(dirOf(f)).carthage = true;
}
if (!dirs.size) process.exit(0);

const trackedUnder = (rel: string, sub: string) => {
  const p = rel === "." ? `${sub}/` : `${rel}/${sub}/`;
  return tracked.some((f) => f.startsWith(p));
};
// A shared scheme for `-workspace` (xcodebuild wants one): the workspace's own, else one
// from a project beside it. Undefined when none is tracked; xcodebuild then decides.
function sharedScheme(rel: string, workspace: string): string | undefined {
  const pre = rel === "." ? "" : `${rel}/`;
  const schemes = tracked
    .filter((f) => f.startsWith(pre) && f.endsWith(".xcscheme"))
    .map((f) => f.slice(pre.length).split("/"))
    .filter((p) => p.length === 4 && /\.(xcworkspace|xcodeproj)$/.test(p[0]!) && p[1] === "xcshareddata" && p[2] === "xcschemes");
  const pick = schemes.find((p) => p[0] === workspace) ?? schemes[0];
  return pick?.[3]!.replace(/\.xcscheme$/, "");
}

type Step = string[];
const plan: { rel: string; steps: Step[] }[] = [];
let skippedNoTool = "";
for (const rel of [...dirs.keys()].sort()) {
  const d = dirs.get(rel)!;
  const abs = `${WT}/${rel}`;
  const baseAbs = `${BASE}/${rel}`;
  if (!isDir(abs)) continue;
  const steps: Step[] = [];
  // CocoaPods first: an app workspace references Pods.xcodeproj, so xcodebuild's
  // resolve below needs it. Only where the base checkout installed Pods/ and it is
  // not committed (a committed Pods/ already came with the checkout).
  if (d.pods && isDir(`${baseAbs}/Pods`) && !trackedUnder(rel, "Pods")) steps.push(["pod", "install"]);
  // Carthage: decided lazily, i.e. only where the base checkout has built frameworks.
  if (d.carthage && isDir(`${baseAbs}/Carthage/Build`) && !trackedUnder(rel, "Carthage/Build"))
    steps.push(["carthage", "bootstrap", "--use-xcframeworks"]);
  // A Swift package: resolve when the lockfile is tracked or the base has resolved it.
  if (d.spm && (d.spmResolved || isDir(`${baseAbs}/.build`))) steps.push(["swift", "package", "resolve"]);
  // An app: xcodebuild caches packages in DerivedData, keyed by the checkout path, so a
  // new worktree always starts cold. The tracked Package.resolved is the signal.
  if (d.containers.size) {
    const all = [...d.containers].sort();
    const ws = all.find((c) => c.endsWith(".xcworkspace"));
    if (ws) {
      const scheme = sharedScheme(rel, ws);
      steps.push(["xcodebuild", "-resolvePackageDependencies", "-workspace", ws, ...(scheme ? ["-scheme", scheme] : [])]);
    } else for (const proj of all) steps.push(["xcodebuild", "-resolvePackageDependencies", "-project", proj]);
  }
  const runnable = steps.filter((st) => {
    if (Bun.which(st[0]!)) return true;
    skippedNoTool += ` ${rel}(${st[0]})`;
    return false;
  });
  if (runnable.length) plan.push({ rel, steps: runnable });
}

if (skippedNoTool) say(`not on PATH, skipped:${skippedNoTool}`);
if (!plan.length) process.exit(0);

// ---- directories run concurrently, a directory's steps in order; one line of summary,
// details only on failure
const show = (st: Step) => st.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(" ");
const logdir = mkdtempSync(`${tmpdir()}/install-deps-`);
say(`installing dependencies in ${plan.length} director${plan.length === 1 ? "y" : "ies"} ...`);
const failed = await Promise.all(
  plan.map(async ({ rel, steps }, i): Promise<Step | null> => {
    const cwd = resolve(WT, rel);
    const fd = openSync(`${logdir}/${i}.log`, "w");
    try {
      for (const st of steps) {
        try {
          // PWD matches the bash subshell's `cd`, so tools see the logical path.
          const p = Bun.spawn(st, { cwd, env: { ...process.env, PWD: cwd }, stdin: "ignore", stdout: fd, stderr: fd });
          if ((await p.exited) !== 0) return st;
        } catch {
          return st;
        }
      }
      return null;
    } finally {
      closeSync(fd);
    }
  }),
);

const ok = plan.filter((_, i) => !failed[i]).map((p) => ` ${p.rel}`).join("");
if (ok) say(`installed:${ok}`);
plan.forEach(({ rel }, i) => {
  const st = failed[i];
  if (!st) return;
  say(`FAILED in ${rel}: ${show(st)} — run it by hand before implementing`);
  const log = readFileSync(`${logdir}/${i}.log`, "utf8").replace(/\n$/, "");
  if (log) console.error(log.split("\n").slice(-15).map((l) => `    ${l}`).join("\n"));
});
rmSync(logdir, { recursive: true, force: true });
