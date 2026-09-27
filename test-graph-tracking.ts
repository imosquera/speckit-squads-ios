#!/usr/bin/env bun
// How seed-graph.ts treats graphify-out/ in version control:
//   no graph anywhere -> skipped, nothing written (#118)
//   untracked graph   -> excluded in info/exclude (a rebuild is never committed)
//   tracked graph     -> left visible: no exclude, no skip-worktree; earlier hiding healed
// Every worktree creation re-runs it, so each run must be idempotent.
// Usage: ./test-graph-tracking.ts
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const SEED = `${import.meta.dir}/extensions/git/scripts/ts/seed-graph.ts`;
const TMP = mkdtempSync(`${tmpdir()}/graph-tracking-`);
let fail = 0;
const expect = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok: ${name}`);
  else {
    console.error(`  FAIL: ${name}`);
    fail = 1;
  }
};
function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString().replace(/\n+$/, "");
}

mkdirSync(`${TMP}/fakebin`);
writeFileSync(`${TMP}/fakebin/graphify`, "#!/usr/bin/env bash\nexit 0\n");
chmodSync(`${TMP}/fakebin/graphify`, 0o755);
const run = (t: string): string => {
  const r = Bun.spawnSync([process.execPath, SEED, t], {
    env: { ...process.env, PATH: `${TMP}/fakebin:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  return r.stdout.toString() + r.stderr.toString();
};

function mkrepo(dir: string, tracked = false): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(`${dir}/a.txt`, "hi\n");
  git(dir, "add", "a.txt");
  if (tracked) {
    mkdirSync(`${dir}/graphify-out`);
    writeFileSync(`${dir}/graphify-out/graph.json`, "{}\n");
    git(dir, "add", "graphify-out");
  }
  git(dir, "commit", "-qm", "one");
}
// seed-graph is exercised in a linked worktree, where it really runs.
const target = (r: string) => (git(r, "worktree", "add", "-q", `${r}.wt`, "-b", "wt"), `${r}.wt`);
const excludeOf = (t: string) => `${git(t, "rev-parse", "--path-format=absolute", "--git-common-dir")}/info/exclude`;
const stanzaCount = (t: string) => {
  try {
    return readFileSync(excludeOf(t), "utf8").split("\n").filter((l) => l === "graphify-out/").length;
  } catch {
    return 0;
  }
};
const skippedCount = (t: string) => git(t, "ls-files", "-v", "--", "graphify-out").split("\n").filter((l) => l.startsWith("S ")).length;
function plantOldInstall(t: string): void {
  // what an earlier run left behind in a tracked repo
  appendFileSync(
    excludeOf(t),
    "# a line the user wrote\n*.log\n\n# Local knowledge graph — rebuilt per checkout, never committed.\n# A committed graph makes the freshness gate report STALE forever.\ngraphify-out/\n",
  );
  git(t, "update-index", "--skip-worktree", "--", ...git(t, "ls-files", "--", "graphify-out").split("\n"));
}

try {
  console.log("no graph anywhere -> skipped, nothing written");
  let R = `${TMP}/nograph`;
  mkrepo(R);
  let T = target(R);
  let out = run(T);
  expect("says it keeps no graph", out.includes("keeps no graph"));
  expect("no exclude stanza", stanzaCount(T) === 0);

  console.log("untracked graph -> excluded, idempotently");
  R = `${TMP}/untracked`;
  mkrepo(R);
  mkdirSync(`${R}/graphify-out`);
  T = target(R);
  run(T);
  run(T);
  expect("exclude stanza written once", stanzaCount(T) === 1);

  console.log("tracked graph -> no exclude, no skip-worktree");
  R = `${TMP}/tracked`;
  mkrepo(R, true);
  T = target(R);
  out = run(T);
  run(T);
  expect("no exclude stanza", stanzaCount(T) === 0);
  expect("no skip-worktree", skippedCount(T) === 0);
  expect("says it was left tracked", out.includes("left tracked"));
  expect("no .graphify_root warning", !out.includes("WARNING"));

  console.log("tracked graph hidden by an earlier run -> healed");
  R = `${TMP}/healed`;
  mkrepo(R, true);
  T = target(R);
  plantOldInstall(T);
  expect("precondition: hidden", skippedCount(T) === 1 && stanzaCount(T) === 1);
  run(T);
  expect("our stanza removed", stanzaCount(T) === 0);
  expect("user exclude lines kept", readFileSync(excludeOf(T), "utf8").split("\n").includes("*.log"));
  expect("skip-worktree cleared", skippedCount(T) === 0);

  console.log("tracked graphify-out/.graphify_root -> warning, never untracked");
  R = `${TMP}/root`;
  mkrepo(R, true);
  writeFileSync(`${R}/graphify-out/.graphify_root`, `${R}\n`);
  git(R, "add", "-f", "graphify-out/.graphify_root");
  git(R, "commit", "-qm", "root");
  T = target(R);
  out = run(T);
  expect("warns with the fix", out.includes("git rm --cached graphify-out/.graphify_root"));
  expect("still tracked", git(T, "ls-files", "--", "graphify-out/.graphify_root") !== "");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

if (fail === 0) console.log("graph tracking check: ok");
else console.error("graph tracking check: FAILED");
process.exit(fail);
