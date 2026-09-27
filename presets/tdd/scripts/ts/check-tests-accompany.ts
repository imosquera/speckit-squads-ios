#!/usr/bin/env bun
// tdd preset: check-tests-accompany.ts
// Fails when the change set touches production source but no test file.
//
// Usage: check-tests-accompany.ts [--base <ref>]
//
// The change set is everything since the merge-base with <base>: committed,
// staged, unstaged, and untracked. <base> defaults to the remote default branch
// (origin/HEAD), then origin/main, main, origin/master, master.
//
// Exit codes:
//   0  production changes are accompanied by test changes (or only tests /
//      non-source files changed)
//   1  production source changed with no test change — the list is printed
//   2  usage error, not a git worktree, or no resolvable base
//   4  empty change set — nothing was examined, which is NOT a pass

function git(...args: string[]): string | null {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

function die(code: number, msg: string): never {
  (code === 2 ? console.error : console.log)(code === 2 ? `error: ${msg}` : msg);
  process.exit(code);
}

const argv = process.argv.slice(2);
let base = "";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--base") {
    base = argv[++i] ?? "";
    if (!base) die(2, "--base needs a ref");
  } else if (a === "-h" || a === "--help") {
    console.log("usage: check-tests-accompany.ts [--base <ref>]");
    process.exit(0);
  } else die(2, `unknown option: ${a}`);
}

const root = git("rev-parse", "--show-toplevel");
if (!root) die(2, "not inside a git worktree");
process.chdir(root);

if (!base) {
  const candidates = [git("symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"),
    "origin/main", "main", "origin/master", "master"];
  base = candidates.find(c => c && git("rev-parse", "-q", "--verify", `${c}^{commit}`) !== null) ?? "";
}
if (!base) die(2, "no base ref resolvable; pass --base <ref>");
const mb = git("merge-base", base, "HEAD");
if (!mb) die(2, `no merge-base between ${base} and HEAD`);

// Spec Kit's installed tooling under .specify/ is vendored, not the project's
// code: a reinstall must not demand tests. The same goes for dependency and
// build trees that some iOS projects commit (CocoaPods, Carthage, SwiftPM's
// .build/, DerivedData).
const VENDORED = /^\.specify\/|(^|\/)(Pods|Carthage|\.build|DerivedData)\//;
const changed = [...new Set([
  ...(git("diff", "--name-only", "--diff-filter=d", mb) ?? "").split("\n"),
  ...(git("ls-files", "--others", "--exclude-standard") ?? "").split("\n"),
].filter(p => p && !VENDORED.test(p)))].sort();
if (!changed.length) die(4, `tdd: empty change set against ${base} — nothing examined`);

// Test files: anything under an XCTest/Swift Testing target directory (SPM's
// Tests/, Xcode's <Target>Tests/ and <Target>UITests/) or a generic tests/
// dir, plus Swift and Objective-C files named *Test / *Tests / *Spec.
const TEST_DIR = /\/([^/]*Tests|tests?)\//;
const TEST_NAME = /(Test|Tests|Spec)\.(swift|m|mm)$/;
// Production code: Swift, Objective-C(++), C/C++ and Metal shaders. Package
// manifests are configuration. Everything else (asset catalogs, storyboards
// and xibs, plists, .xcstrings, project.pbxproj, Package.resolved,
// .xcconfig) is non-code: it never demands a test.
const SOURCE = /\.(swift|m|mm|h|c|cc|cpp|hpp|metal)$/;
const MANIFEST = /^Package(@swift-[\d.]+)?\.swift$/;

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const isTest = (p: string) => TEST_DIR.test(`/${p}`) || TEST_NAME.test(nameOf(p));

const tests = changed.filter(isTest).length;
const prod = changed.filter(p => !isTest(p) && SOURCE.test(p) && !MANIFEST.test(nameOf(p)));

if (prod.length && !tests) {
  die(1, [`tdd: production source changed against ${base} with no test change:`, ...prod.map(p => `  ${p}`)].join("\n"));
}
console.log(`tdd: ok — ${prod.length} production file(s), ${tests} test file(s) changed against ${base}`);
