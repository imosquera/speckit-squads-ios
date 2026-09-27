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

const changed = [...new Set([
  ...(git("diff", "--name-only", "--diff-filter=d", mb) ?? "").split("\n"),
  ...(git("ls-files", "--others", "--exclude-standard") ?? "").split("\n"),
// Spec Kit's installed tooling under .specify/ is vendored, not the project's
// code: a reinstall must not demand tests.
].filter(p => p && !p.startsWith(".specify/")))].sort();
if (!changed.length) die(4, `tdd: empty change set against ${base} — nothing examined`);

const TEST_DIR = /\/(tests?|__tests__|specs?|testing)\//;
const TEST_NAME = [/^test_.*\.py$/, /_test\.(py|go|rb|exs?)$/, /\.(test|spec)\.[A-Za-z]+$/,
  /_spec\.rb$/, /(Test|Tests|Spec)\.(java|kt|swift|cs|scala|php)$/, /^test-.*\.sh$/];
const SOURCE = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|rb|java|kt|swift|cs|php|c|cc|cpp|h|hpp|scala|ex|exs|sh)$/;

const isTest = (p: string) => {
  const name = p.slice(p.lastIndexOf("/") + 1);
  return TEST_DIR.test(`/${p}`) || TEST_NAME.some(re => re.test(name));
};

const tests = changed.filter(isTest).length;
const prod = changed.filter(p => !isTest(p) && SOURCE.test(p));

if (prod.length && !tests) {
  die(1, [`tdd: production source changed against ${base} with no test change:`, ...prod.map(p => `  ${p}`)].join("\n"));
}
console.log(`tdd: ok — ${prod.length} production file(s), ${tests} test file(s) changed against ${base}`);
