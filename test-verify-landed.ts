#!/usr/bin/env bun
// Checks the git extension's landed gate (verify-landed.ts) and that clean.ts
// fails closed on it. Squash merges break ancestry, so content decides (issue #49).
// Usage: bun test-verify-landed.ts
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = join(import.meta.dir, "extensions/git/scripts/ts");
const VERIFY = join(SRC, "verify-landed.ts");
// Physical path: git reports resolved worktree paths and macOS $TMPDIR is a symlink.
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "verify-landed-")));
let fail = 0;

function check(what: string, desc: string, want: string | number | boolean, got: string | number | boolean | undefined): void {
  if (String(want) === String(got)) console.log(`  ok: ${what} ${desc}`);
  else {
    console.error(`  FAIL: ${what} ${desc} — expected '${want}', got '${got}'`);
    fail = 1;
  }
}
function contains(what: string, needle: string, hay: string): void {
  if (hay.includes(needle)) console.log(`  ok: ${what} mentions '${needle}'`);
  else {
    console.error(`  FAIL: ${what} does not mention '${needle}'\n${hay.replace(/^/gm, "        ")}`);
    fail = 1;
  }
}
function git(r: string, ...args: string[]): boolean {
  return Bun.spawnSync(["git", "-C", r, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}
const write = (p: string, s: string) => writeFileSync(p, `${s}\n`);
const DIRS = ["functions", "web", "infra", "specs"];

// One commit in each of several dirs, so a check that narrows to one dir shows up.
function newRepo(r: string): string {
  mkdirSync(r, { recursive: true });
  git(r, "init", "-q", "-b", "main");
  git(r, "config", "user.email", "t@t");
  git(r, "config", "user.name", "t");
  for (const d of DIRS) {
    mkdirSync(`${r}/${d}`, { recursive: true });
    write(`${r}/${d}/f.txt`, "base");
  }
  git(r, "add", "-A");
  git(r, "commit", "-qm", "base");
  return r;
}
const commitAll = (r: string, msg: string) => git(r, "add", "-A") && git(r, "commit", "-qm", msg);
const squashInto = (r: string, br: string, msg: string) =>
  git(r, "checkout", "-q", "main") && git(r, "merge", "--squash", "-q", br) && git(r, "commit", "-qm", msg);

let OUT = "";
let RC = 0;
function exec(cmd: string[]): void {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  OUT = (p.stdout.toString() + p.stderr.toString()).replace(/\n+$/, "");
  RC = p.exitCode ?? -1;
}
const run = (...args: string[]) => exec(["bun", VERIFY, ...args, "--no-fetch"]);
// First word of the first line, matched whole: NOT-LANDED contains LANDED.
const verdict = () => (OUT.split("\n")[0] ?? "").split(":")[0];

try {
  console.log("1. squash-merged branch -> LANDED (ancestry says otherwise, content does not)");
  let R = newRepo(`${TMP}/squash`);
  git(R, "checkout", "-qb", "feat");
  for (const d of DIRS) write(`${R}/${d}/f.txt`, "work");
  commitAll(R, "feature work");
  squashInto(R, "feat", "feat (#1)");
  check("squash", "precondition: not an ancestor", false, git(R, "merge-base", "--is-ancestor", "feat", "main"));
  run("feat", "--repo", R);
  check("squash", "exit code", 0, RC);
  check("squash", "verdict", "LANDED", verdict());

  console.log("2. commit pushed after the squash -> NOT-LANDED (the near-miss from #49)");
  git(R, "checkout", "-q", "feat");
  write(`${R}/infra/late.txt`, "stranded");
  commitAll(R, "late fix");
  git(R, "checkout", "-q", "main");
  run("feat", "--repo", R);
  check("stranded", "exit code", 1, RC);
  check("stranded", "verdict", "NOT-LANDED", verdict());
  contains("stranded", "infra/late.txt", OUT);

  console.log("3. never-merged branch -> NOT-LANDED");
  R = newRepo(`${TMP}/never`);
  git(R, "checkout", "-qb", "solo");
  write(`${R}/web/only-here.txt`, "mine");
  commitAll(R, "solo");
  git(R, "checkout", "-q", "main");
  run("solo", "--repo", R);
  check("unmerged", "exit code", 1, RC);
  contains("unmerged", "web/only-here.txt", OUT);

  console.log("4. true merge -> LANDED via ancestry");
  R = newRepo(`${TMP}/merged`);
  git(R, "checkout", "-qb", "feat");
  write(`${R}/web/f.txt`, "work");
  commitAll(R, "work");
  git(R, "checkout", "-q", "main");
  git(R, "merge", "-q", "--no-ff", "-m", "merge", "feat");
  run("feat", "--repo", R);
  check("merge", "exit code", 0, RC);
  contains("merge", "ancestor", OUT);

  console.log("5. rebase-and-merge -> LANDED (new shas, identical content)");
  R = newRepo(`${TMP}/rebase`);
  git(R, "checkout", "-qb", "feat");
  write(`${R}/functions/f.txt`, "work");
  commitAll(R, "work");
  git(R, "checkout", "-q", "main");
  write(`${R}/specs/f.txt`, "other");
  commitAll(R, "other");
  git(R, "cherry-pick", "feat");
  run("feat", "--repo", R);
  check("rebase", "exit code", 0, RC);
  check("rebase", "verdict", "LANDED", verdict());

  console.log("6. base moved on independently -> still LANDED (the gate must not cry wolf)");
  write(`${R}/web/f.txt`, "more");
  commitAll(R, "unrelated main work");
  run("feat", "--repo", R);
  check("moved-base", "exit code", 0, RC);

  console.log("7. unknown branch -> UNKNOWN, and UNKNOWN refuses");
  run("no-such-branch", "--repo", R);
  check("unknown-branch", "exit code", 2, RC);
  check("unknown-branch", "verdict", "UNKNOWN", verdict());
  contains("unknown-branch", "do not delete", OUT);

  console.log("8. unresolvable base -> UNKNOWN, never a pass");
  run("feat", "--repo", R, "--base", "release-that-does-not-exist");
  check("unknown-base", "exit code", 2, RC);
  check("unknown-base", "verdict", "UNKNOWN", verdict());

  console.log("9. differences confined to an excluded path -> LANDED");
  R = newRepo(`${TMP}/excluded`);
  git(R, "checkout", "-qb", "feat");
  mkdirSync(`${R}/graphify-out`);
  write(`${R}/graphify-out/graph.json`, "generated");
  commitAll(R, "graph");
  git(R, "checkout", "-q", "main");
  run("feat", "--repo", R);
  check("excluded-off", "exit code (not excluded yet)", 1, RC);
  run("feat", "--repo", R, "--exclude", "graphify-out");
  check("excluded-on", "exit code", 0, RC);

  console.log("10. --json emits a machine-readable verdict");
  R = newRepo(`${TMP}/json`);
  git(R, "checkout", "-qb", "feat");
  write(`${R}/web/f.txt`, "w");
  commitAll(R, "w");
  squashInto(R, "feat", "feat (#2)");
  run("feat", "--repo", R, "--json");
  check("json", "exit code", 0, RC);
  check(
    "json",
    "line",
    '{"landed": true, "verdict": "LANDED", "branch": "feat", "base": "main", "via": "content", "paths_checked": 1}',
    OUT,
  );

  console.log("11. squash landed on the fetched origin/main while local main is stale -> LANDED");
  R = newRepo(`${TMP}/stale-base`);
  const bare = `${TMP}/stale-base-origin.git`;
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", bare]);
  git(R, "remote", "add", "origin", bare);
  const pre = Bun.spawnSync(["git", "-C", R, "rev-parse", "main"]).stdout.toString().trim();
  git(R, "checkout", "-qb", "feat");
  for (const d of DIRS) write(`${R}/${d}/f.txt`, "work");
  commitAll(R, "feature work");
  squashInto(R, "feat", "feat (#11)");
  git(R, "push", "-q", "origin", "main");
  git(R, "reset", "-q", "--hard", pre);
  run("feat", "--repo", R);
  check("stale-base", "exit code", 0, RC);
  check("stale-base", "verdict", "LANDED", verdict());
  contains("stale-base", "origin/main", OUT);

  console.log("12. path changed then reverted after the squash -> NOT-LANDED");
  R = newRepo(`${TMP}/reverted`);
  git(R, "checkout", "-qb", "feat");
  write(`${R}/functions/f.txt`, "work");
  write(`${R}/web/f.txt`, "work");
  commitAll(R, "change f and g");
  squashInto(R, "feat", "feat (#12)");
  git(R, "checkout", "-q", "feat");
  write(`${R}/functions/f.txt`, "base");
  commitAll(R, "revert functions/f.txt");
  git(R, "checkout", "-q", "main");
  run("feat", "--repo", R);
  check("reverted", "exit code", 1, RC);
  check("reverted", "verdict", "NOT-LANDED", verdict());
  contains("reverted", "functions/f.txt", OUT);

  // --- clean.ts: the gate must fail closed, not skip ---
  const cleanRepo = (r: string) => {
    newRepo(r);
    cpSync(SRC, `${r}/ext/scripts/ts`, { recursive: true });
    commitAll(r, "scripts");
    return r;
  };
  const runClean = (r: string, ...args: string[]) => exec(["bun", `${r}/ext/scripts/ts/clean.ts`, ...args]);

  console.log("13. clean.ts on a detached HEAD carrying unlanded work -> refuse");
  R = cleanRepo(`${TMP}/clean-detached`);
  git(R, "checkout", "-qb", "feat");
  write(`${R}/infra/late.txt`, "stranded");
  commitAll(R, "late fix");
  git(R, "checkout", "-q", "main");
  git(R, "checkout", "-q", "--detach", "feat");
  runClean(R, "--worktree", R);
  check("detached", "exit code", 1, RC);
  contains("detached", "refusing", OUT);
  runClean(R, "--worktree", R, "--force");
  check("detached-force", "exit code (--force is the escape hatch)", 0, RC);

  console.log("14. clean.ts with a verifier it cannot run -> refuse");
  R = cleanRepo(`${TMP}/clean-noverify`);
  git(R, "checkout", "-qb", "feat");
  write(`${R}/infra/late.txt`, "stranded");
  commitAll(R, "late fix");
  rmSync(`${R}/ext/scripts/ts/verify-landed.ts`);
  commitAll(R, "verifier gone");
  runClean(R, "--worktree", R);
  check("no-verifier", "exit code", 1, RC);
  contains("no-verifier", "verify-landed.ts is missing", OUT);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(fail === 0 ? "ALL PASS" : "FAILURES");
process.exit(fail);
