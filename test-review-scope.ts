#!/usr/bin/env bun
// Check that detect-changed-files.ts reports the scope a reviewer must be given:
// the absolute worktree root and the exact diff base, for local changes (Modes
// A/B) and for a pull request (Mode C, `--pr <N>`, with `gh` stubbed on PATH).
// Without them a reviewer can review an unrelated checkout and look clean (#52).
// Also checks the iOS/Xcode noise filter: project.pbxproj, asset catalogs,
// xcuserdata and snapshot images go to ignored_files; Package.swift never does.
//
// Usage: bun test-review-scope.ts
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DETECT = join(import.meta.dir, "extensions/review/scripts/ts/detect-changed-files.ts");
const TMP = mkdtempSync(join(tmpdir(), "review-scope."));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
let fail = 0;

function check(what: string, expected: string, actual: string) {
  if (expected === actual) console.log(`  ok: ${what}`);
  else { console.error(`  FAIL: ${what} — expected '${expected}', got '${actual}'`); fail = 1; }
}

function sh(cmd: string[], cwd?: string, env?: Record<string, string>) {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { rc: r.exitCode, out: r.stdout.toString().replace(/\n+$/, "") };
}
const git = (dir: string, ...args: string[]) => sh(["git", "-C", dir, ...args]).out;
const detect = (cwd: string, args: string[] = [], env?: Record<string, string>) => {
  const r = sh(["bun", DETECT, "--json", ...args], cwd, env);
  let j: Record<string, any> = {};
  try { j = JSON.parse(r.out); } catch {}
  return { rc: r.rc, out: r.out, j };
};

const REPO = join(TMP, "repo");
mkdirSync(REPO);
git(REPO, "init", "-q", "-b", "main");
git(REPO, "config", "user.email", "t@t"); git(REPO, "config", "user.name", "t");
writeFileSync(join(REPO, "a.txt"), "base\n");
git(REPO, "add", "-A"); git(REPO, "commit", "-qm", "base");
// origin/main is what the detector resolves the merge-base against
git(REPO, "remote", "add", "origin", REPO);
git(REPO, "update-ref", "refs/remotes/origin/main", "main");
const BASE = git(REPO, "rev-parse", "main");
const TOP = git(REPO, "rev-parse", "--show-toplevel");

// --- Mode A: feature branch ---
git(REPO, "checkout", "-qb", "feat");
appendFileSync(join(REPO, "a.txt"), "change\n");
git(REPO, "commit", "-qam", "change");
let o = detect(REPO);
check("mode A repo_root is the worktree root", TOP, o.j.repo_root);
check("mode A diff_base is the merge-base", BASE, o.j.diff_base);
check("mode A diff_base resolves", "a.txt", git(REPO, "diff", "--name-only", o.j.diff_base));

// Two-dot diff against the base reaches the working tree; three-dot would drop it.
appendFileSync(join(REPO, "b.txt"), "uncommitted\n");
git(REPO, "add", "b.txt");
o = detect(REPO);
check("diff_base covers staged work", "a.txt\nb.txt", git(REPO, "diff", "--name-only", o.j.diff_base));
git(REPO, "reset", "-q"); rmSync(join(REPO, "b.txt"));
mkdirSync(join(REPO, "sub"));
check("repo_root ignores caller cwd", TOP, detect(join(REPO, "sub")).j.repo_root);

// --- Mode B: on the default branch, uncommitted only ---
git(REPO, "checkout", "-q", "main");
appendFileSync(join(REPO, "a.txt"), "dirty\n");
o = detect(REPO);
check("mode B repo_root still reported", TOP, o.j.repo_root);
check("mode B diff_base is empty", "", o.j.diff_base);

// Untracked files appear in no diff, so changed_files must carry them.
git(REPO, "checkout", "-q", "--", "a.txt");
writeFileSync(join(REPO, "brand-new.txt"), "new\n");
o = detect(REPO);
if (o.out.includes('"brand-new.txt"')) console.log("  ok: untracked-only change set is still reported");
else { console.error("  FAIL: untracked-only change set missing from changed_files"); fail = 1; }
check("untracked-only diff is empty (so the file list must carry it)", "", git(REPO, "diff", "--name-only", "HEAD"));

// --- Mode C: --pr <N>, with `gh` stubbed on PATH ---
// The stub answers `gh pr view --jq ".a, .b"` from $STUB_VIEW and
// `gh pr diff --name-only` from $STUB_DIFF; STUB_FAIL=1 makes every call fail.
const STUBBIN = join(TMP, "bin");
mkdirSync(STUBBIN);
writeFileSync(join(STUBBIN, "gh"), `#!/usr/bin/env bun
const a = process.argv.slice(2);
if (process.env.STUB_FAIL === "1") { console.error("gh: HTTP 404: Not Found"); process.exit(1); }
if (a[0] === "pr" && a[1] === "view") {
  const v = JSON.parse(process.env.STUB_VIEW ?? "{}");
  const jq = a[a.indexOf("--jq") + 1] ?? "";
  for (const k of jq.split(",")) console.log(String(v[k.trim().slice(1)]));
} else if (a[0] === "pr" && a[1] === "diff") console.log(process.env.STUB_DIFF ?? "");
else { console.error("stub gh: unexpected " + a.join(" ")); process.exit(1); }
`);
chmodSync(join(STUBBIN, "gh"), 0o755);

const ORIGIN = join(TMP, "origin.git"), SEED = join(TMP, "seed"), CLONE = join(TMP, "clone");
sh(["git", "init", "-q", "--bare", "-b", "main", ORIGIN]);
sh(["git", "clone", "-q", ORIGIN, SEED]);
git(SEED, "config", "user.email", "t@t"); git(SEED, "config", "user.name", "t");
writeFileSync(join(SEED, "keep.txt"), "base\n"); writeFileSync(join(SEED, "gone.txt"), "doomed\n");
git(SEED, "add", "-A"); git(SEED, "commit", "-qm", "base"); git(SEED, "push", "-q", "origin", "main");
const PR_BASE = git(SEED, "rev-parse", "HEAD");
sh(["git", "clone", "-q", ORIGIN, CLONE]); // before the PR exists: no head object
git(SEED, "checkout", "-qb", "feat/pr");
appendFileSync(join(SEED, "keep.txt"), "edit\n"); writeFileSync(join(SEED, "added.txt"), "new\n");
git(SEED, "rm", "-q", "gone.txt");
mkdirSync(join(SEED, "graphify-out")); writeFileSync(join(SEED, "graphify-out/graph.json"), "{}\n");
mkdirSync(join(SEED, "App.xcodeproj")); writeFileSync(join(SEED, "App.xcodeproj/project.pbxproj"), "// !$*UTF8*$!\n");
git(SEED, "add", "-A"); git(SEED, "commit", "-qm", "pr"); git(SEED, "push", "-q", "origin", "feat/pr");
const PR_HEAD = git(SEED, "rev-parse", "HEAD");

const view = (head: string, cross = false) => JSON.stringify({
  number: 7, headRefName: "feat/pr", headRefOid: head, baseRefName: "main",
  url: "https://github.com/o/r/pull/7", title: 'Add "thing"', isCrossRepository: cross,
});
const STUB_DIFF = "keep.txt\nadded.txt\ngone.txt\ngraphify-out/graph.json\nApp.xcodeproj/project.pbxproj";
const PATH = `${STUBBIN}:${process.env.PATH}`;
const runc = (dir: string, v: string, extra: Record<string, string> = {}) =>
  detect(dir, ["--pr", "7"], { PATH, STUB_VIEW: v, STUB_DIFF, ...extra });

// checkout=none: the head branch is checked out nowhere.
o = runc(CLONE, view(PR_HEAD));
check("mode C (none) exits 0", "0", String(o.rc));
check("mode C (none) checkout", "none", o.j.checkout);
check("mode C (none) repo_root is the current checkout", git(CLONE, "rev-parse", "--show-toplevel"), o.j.repo_root);
check("mode C (none) head is the PR head sha", PR_HEAD, o.j.head);
check("mode C (none) head was fetched", "commit", git(CLONE, "cat-file", "-t", PR_HEAD));
check("mode C diff_base is merge-base(origin/main, head)", PR_BASE, o.j.diff_base);
check("mode C pr / pr_url / pr_title", '7|https://github.com/o/r/pull/7|Add "thing"', `${o.j.pr}|${o.j.pr_url}|${o.j.pr_title}`);
// deletions dropped (as ACMR does in A/B); graphify-out left for the coordinator
check("mode C changed_files from gh minus deletions", "keep.txt added.txt graphify-out/graph.json", (o.j.changed_files ?? []).join(" "));
check("mode C pbxproj goes to ignored_files", "App.xcodeproj/project.pbxproj", (o.j.ignored_files ?? []).join(" "));
check("mode C diff <base> <head> resolves", "App.xcodeproj/project.pbxproj\nadded.txt\ngone.txt\ngraphify-out/graph.json\nkeep.txt", git(CLONE, "diff", "--name-only", o.j.diff_base, o.j.head));
check("mode C git show <head>:<path> reads the PR copy", "base\nedit", git(CLONE, "show", `${o.j.head}:keep.txt`));

// checkout=worktree, in a path with a space: repo_root must be the whole path.
const WT = join(TMP, "wt with space");
git(CLONE, "worktree", "add", "-q", WT, "-b", "feat/pr", PR_HEAD);
o = runc(CLONE, view(PR_HEAD));
check("mode C (worktree) exits 0", "0", String(o.rc));
check("mode C (worktree) checkout", "worktree", o.j.checkout);
const real = (p: string) => { try { return realpathSync(p); } catch { return ""; } };
check("mode C (worktree) repo_root is the worktree path", real(WT), real(o.j.repo_root ?? ""));
check("mode C (worktree) branch is the head branch", "feat/pr", o.j.branch);
check("mode C (worktree) HEAD matches head", o.j.head, git(o.j.repo_root, "rev-parse", "HEAD"));

// A fork's branch name says nothing about a same-named local branch.
check("mode C cross-repo PR never binds a local worktree", "none", runc(CLONE, view(PR_HEAD, true)).j.checkout);

// Failures are loud: gh failing, or a head that cannot be obtained.
o = runc(CLONE, view(PR_HEAD), { STUB_FAIL: "1" });
check("mode C gh failure exits 1", "1", String(o.rc));
if (String(o.j.error ?? "").includes("gh pr view 7 failed")) console.log("  ok: gh failure message names the call");
else { console.error(`  FAIL: gh failure message unclear: ${o.out}`); fail = 1; }
o = runc(CLONE, view("0123456789abcdef0123456789abcdef01234567"));
check("mode C unobtainable head exits 1", "1", String(o.rc));
check("--pr with no number exits 1", "1", String(detect(CLONE, ["--pr"], { PATH }).rc));

// Modes A/B keep the same JSON shape: the Mode C keys exist, empty.
o = detect(REPO);
check("mode A/B carry empty pr/pr_url/head/checkout", "|||", `${o.j.pr}|${o.j.pr_url}|${o.j.head}|${o.j.checkout}`);
check("mode A/B carry ignored_files", "true", String(Array.isArray(o.j.ignored_files)));

// --- iOS/Xcode noise: churn is reported apart, manifests stay reviewable ---
rmSync(join(REPO, "brand-new.txt"));
git(REPO, "checkout", "-qb", "ios");
const put = (rel: string, body = "x\n") => {
  mkdirSync(join(REPO, rel, ".."), { recursive: true });
  writeFileSync(join(REPO, rel), body);
};
put("Package.swift", "// swift-tools-version:6.0\n");
put("Package.resolved", "{}\n");
put("App/ContentView.swift", "import SwiftUI\n");
put("App/Legacy.m", "@import UIKit;\n");
put("App/Info.plist", "<plist/>\n");
put("App.xcodeproj/project.pbxproj", "// !$*UTF8*$!\n");
put("App.xcodeproj/project.xcworkspace/contents.xcworkspacedata", "<Workspace/>\n");
put("App.xcodeproj/xcuserdata/me.xcuserdatad/xcschemes/xcschememanagement.plist", "<plist/>\n");
put("App/Assets.xcassets/AppIcon.appiconset/Contents.json", "{}\n");
put("AppTests/__Snapshots__/ContentViewTests/testLight.1.png", "png\n");
put("AppTests/ContentViewTests.swift", "import Testing\n");
git(REPO, "add", "-A"); git(REPO, "commit", "-qm", "ios");
o = detect(REPO);
check("ios: exits 0", "0", String(o.rc));
check("ios: reviewable files (Package.swift/Package.resolved kept)",
  "App/ContentView.swift App/Info.plist App/Legacy.m AppTests/ContentViewTests.swift Package.resolved Package.swift",
  [...(o.j.changed_files ?? [])].sort().join(" "));
check("ios: Xcode churn in ignored_files",
  "App.xcodeproj/project.pbxproj App.xcodeproj/project.xcworkspace/contents.xcworkspacedata App.xcodeproj/xcuserdata/me.xcuserdatad/xcschemes/xcschememanagement.plist App/Assets.xcassets/AppIcon.appiconset/Contents.json AppTests/__Snapshots__/ContentViewTests/testLight.1.png",
  [...(o.j.ignored_files ?? [])].sort().join(" "));

// A change of nothing but churn is "nothing to review" (exit 2), not an empty pass.
git(REPO, "checkout", "-qb", "ios-churn");
git(REPO, "update-ref", "refs/remotes/origin/main", "ios");
appendFileSync(join(REPO, "App.xcodeproj/project.pbxproj"), "churn\n");
o = detect(REPO);
check("ios churn-only exits 2", "2", String(o.rc));
check("ios churn-only changed_files empty", "", (o.j.changed_files ?? ["?"]).join(" "));
check("ios churn-only still lists ignored_files", "App.xcodeproj/project.pbxproj", (o.j.ignored_files ?? []).join(" "));

console.log(fail === 0 ? "PASS" : "FAIL");
process.exit(fail);
