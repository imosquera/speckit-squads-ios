#!/usr/bin/env bun
// Checks the git extension's one handler for `commit_exclude` churn
// (scrub-commit-exclude.ts), its callers clean.ts and create-pr.ts, and auto-commit.ts,
// which holds excluded paths out of its commit without scrubbing (issue #109). create-pr.ts runs against a local bare origin and a stubbed gh;
// nothing leaves the machine.
// Usage: bun test-commit-exclude.ts
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFeatureJson } from "./extensions/git/scripts/ts/git-common.ts";

const ROOT = import.meta.dir;
const SRC = join(ROOT, "extensions/git/scripts/ts");
const TMP = mkdtempSync(join(tmpdir(), "commit-exclude-"));
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
function git(r: string, ...args: string[]): string {
  return Bun.spawnSync(["git", "-C", r, ...args], { stdout: "pipe", stderr: "ignore" }).stdout.toString().replace(/\n+$/, "");
}
const read = (p: string) => readFileSync(p, "utf8").replace(/\n+$/, "");
const write = (p: string, s: string) => writeFileSync(p, `${s}\n`);
const EXT = ".specify/extensions/git";

// A consumer-shaped repo: the extension under .specify/extensions/git/, graphify-out/ tracked and excluded.
function makeRepo(r: string, excl = "  - graphify-out", extra = "auto_commit:\n  default: false\n"): string {
  mkdirSync(`${r}/${EXT}/scripts`, { recursive: true });
  cpSync(SRC, `${r}/${EXT}/scripts/ts`, { recursive: true });
  writeFileSync(`${r}/${EXT}/git-config.yml`, `squash_before_pr: true\ncommit_exclude:\n${excl}\n\n${extra}`);
  git(r, "init", "-q", "-b", "main");
  git(r, "config", "user.email", "t@t");
  git(r, "config", "user.name", "t");
  mkdirSync(`${r}/graphify-out`);
  write(`${r}/graphify-out/graph.json`, '{"nodes":[]}');
  write(`${r}/app.txt`, "source");
  git(r, "add", "-A");
  git(r, "commit", "-qm", "base");
  return r;
}
function runIn(cwd: string, cmd: string[], env: Record<string, string | undefined> = {}): { out: string; rc: number } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  return { out: (p.stdout.toString() + p.stderr.toString()).replace(/\n+$/, ""), rc: p.exitCode ?? -1 };
}
const scrub = (r: string, ...args: string[]) => runIn(r, ["bun", `${r}/${EXT}/scripts/ts/scrub-commit-exclude.ts`, "--repo", r, ...args]);

try {
  console.log("1. a modified excluded path is restored to HEAD; real work is untouched");
  let R = makeRepo(`${TMP}/r1`);
  write(`${R}/graphify-out/graph.json`, '{"nodes":[1,2,3]}');
  write(`${R}/app.txt`, "edited");
  let s = scrub(R);
  check("scrub", "exit code", 0, s.rc);
  contains("scrub", "graphify-out", s.out);
  check("graph", "restored", '{"nodes":[]}', read(`${R}/graphify-out/graph.json`));
  check("work", "preserved", "edited", read(`${R}/app.txt`));

  console.log("2. untracked output under an excluded path is removed");
  R = makeRepo(`${TMP}/r2`);
  mkdirSync(`${R}/graphify-out/2026-09-10`);
  write(`${R}/graphify-out/2026-09-10/cost.json`, '{"cost":1}');
  scrub(R);
  check("untracked", "removed", false, existsSync(`${R}/graphify-out/2026-09-10/cost.json`));

  console.log("3. a STAGED excluded path is unstaged, not committed");
  R = makeRepo(`${TMP}/r3`);
  write(`${R}/graphify-out/graph.json`, '{"nodes":[9]}');
  write(`${R}/app.txt`, "edited");
  git(R, "add", "-A");
  scrub(R);
  check("staged", "index carries no excluded path", "", git(R, "diff", "--cached", "--name-only", "--", "graphify-out"));
  check("staged", "real work still staged", "app.txt", git(R, "diff", "--cached", "--name-only", "--", "app.txt"));

  console.log("4. auto-commit leaves excluded paths on disk and out of the commit (issue #109)");
  R = makeRepo(`${TMP}/r4`, "  - graphify-out", "auto_commit:\n  default: true\n");
  write(`${R}/graphify-out/graph.json`, '{"nodes":[7]}');
  write(`${R}/graphify-out/new.json`, '{"cost":1}');
  write(`${R}/app.txt`, "edited");
  git(R, "add", "-A"); // already staged by the flow
  runIn(R, ["bun", `${R}/${EXT}/scripts/ts/auto-commit.ts`, "after_plan"]);
  check("auto-commit", "modified graph survives", '{"nodes":[7]}', read(`${R}/graphify-out/graph.json`));
  check("auto-commit", "untracked graph output survives", '{"cost":1}', read(`${R}/graphify-out/new.json`));
  check("auto-commit", "real work committed", "app.txt", git(R, "show", "--name-only", "--pretty=", "HEAD", "--", "app.txt"));
  check("auto-commit", "commit carries no excluded path", "", git(R, "show", "--name-only", "--pretty=", "HEAD", "--", "graphify-out"));

  console.log("5. an empty commit_exclude list is a silent no-op");
  R = makeRepo(`${TMP}/r5`, "  []");
  writeFileSync(`${R}/${EXT}/git-config.yml`, "commit_exclude: []\nauto_commit:\n  default: false\n");
  write(`${R}/graphify-out/graph.json`, '{"nodes":[4]}');
  s = scrub(R);
  check("empty-list", "exit code", 0, s.rc);
  check("empty-list", "no output", "", s.out);
  check("empty-list", "leaves the tree alone", '{"nodes":[4]}', read(`${R}/graphify-out/graph.json`));

  console.log("6. a clean tree scrubs nothing and still exits 0");
  R = makeRepo(`${TMP}/r6`);
  s = scrub(R);
  check("clean-tree", "exit code", 0, s.rc);
  contains("clean-tree", "nothing to scrub", s.out);

  console.log("7. --require-clean flags dirt OUTSIDE the excluded paths only");
  R = makeRepo(`${TMP}/r7`);
  write(`${R}/graphify-out/graph.json`, '{"nodes":[5]}');
  check("require-clean", "excluded-only dirt exits 0", 0, scrub(R, "--require-clean").rc);
  write(`${R}/app.txt`, "edited");
  s = scrub(R, "--require-clean");
  check("require-clean", "real dirt exits 2", 2, s.rc);
  contains("require-clean", "app.txt", s.out);

  console.log("8. a rebuild in flight is waited for, not raced (issue #55)");
  R = makeRepo(`${TMP}/r8`);
  write(`${R}/graphify-out/.rebuild.lock`, "");
  write(`${R}/graphify-out/graph.json`, '{"nodes":[6]}');
  s = runIn(R, ["bun", `${R}/${EXT}/scripts/ts/scrub-commit-exclude.ts`, "--repo", R], { SPECKIT_SCRUB_LOCK_TIMEOUT: "2" });
  contains("lock", "Waiting for a rebuild in flight", s.out);
  contains("lock", "scrubbing anyway", s.out);
  check("lock", "still scrubs after the timeout", '{"nodes":[]}', read(`${R}/graphify-out/graph.json`));

  console.log("9. create-pr and clean reach the one handler; auto-commit does not (issue #109)");
  check("auto-commit.ts", "does not scrub", false, read(join(SRC, "auto-commit.ts")).includes("scrub-commit-exclude.ts"));
  for (const f of ["create-pr.ts", "clean.ts"]) {
    check(f, "calls scrub-commit-exclude.ts", true, read(join(SRC, f)).includes("scrub-commit-exclude.ts"));
  }
  check("extension.yml", "declares scripts/ts/scrub-commit-exclude.ts", true, read(join(ROOT, "extensions/git/extension.yml")).includes("scripts/ts/scrub-commit-exclude.ts"));

  console.log("10. a NEWLY ADDED excluded file is left neither staged nor on disk");
  R = makeRepo(`${TMP}/r10`);
  mkdirSync(`${R}/graphify-out/2026-09-10`);
  write(`${R}/graphify-out/2026-09-10/cost.json`, '{"cost":1}');
  write(`${R}/app.txt`, "edited");
  git(R, "add", "-A");
  scrub(R);
  check("new-addition", "index carries no excluded path", "", git(R, "diff", "--cached", "--name-only", "--", "graphify-out"));
  check("new-addition", "nothing left untracked", "", git(R, "ls-files", "--others", "--exclude-standard", "--", "graphify-out"));
  check("new-addition", "removed from disk", false, existsSync(`${R}/graphify-out/2026-09-10/cost.json`));
  check("new-addition", "real work still staged", "app.txt", git(R, "diff", "--cached", "--name-only", "--", "app.txt"));

  console.log("11. auto-commit enabled: commits real work, holds out excluded paths, appends Closes #N");
  R = makeRepo(`${TMP}/r11`, "  - graphify-out", "auto_commit:\n  default: true\n");
  writeFeatureJson(R, "7");
  git(R, "add", "-A");
  git(R, "commit", "-qm", "link");
  write(`${R}/app.txt`, "edited");
  git(R, "add", "app.txt");
  write(`${R}/graphify-out/graph.json`, '{"nodes":[8]}');
  s = runIn(R, ["bun", `${R}/${EXT}/scripts/ts/auto-commit.ts`, "after_plan"]);
  check("auto-commit-on", "exit code", 0, s.rc);
  check("auto-commit-on", "message", "[Spec Kit] Auto-commit after plan\n\nCloses #7", git(R, "log", "-1", "--pretty=%B"));
  check("auto-commit-on", "commit touches only app.txt", "app.txt", git(R, "show", "--name-only", "--pretty=", "HEAD"));

  console.log("12. create-pr --draft: draft, #N title, Closes #N, labels copied minus autopilot:*, excluded history reset");
  R = makeRepo(`${TMP}/r12`);
  const bare = `${TMP}/r12-origin.git`;
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", bare]);
  git(R, "remote", "add", "origin", bare);
  git(R, "push", "-q", "origin", "main");
  git(R, "checkout", "-qb", "042-demo");
  mkdirSync(`${R}/specs/042-demo`, { recursive: true });
  write(`${R}/specs/042-demo/spec.md`, "# Feature Specification: Demo thing\n\nbody");
  writeFeatureJson(R, "7");
  write(`${R}/graphify-out/graph.json`, '{"nodes":["branch"]}');
  git(R, "add", "-A");
  git(R, "commit", "-qm", "spec and a stray graph");
  write(`${R}/app.txt`, "feature");
  git(R, "commit", "-qam", "work");

  // Stub gh: logs argv as JSON lines; no PR exists yet; issue #7 has three labels.
  const bin = `${TMP}/bin`;
  const log = `${TMP}/gh.log`;
  mkdirSync(bin);
  writeFileSync(
    `${bin}/gh`,
    `#!/usr/bin/env bun
const a = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
const k = a.slice(0, 2).join(" ");
if (k === "pr view") process.exit(1);
if (k === "pr create") console.log("https://example.test/pull/1");
if (k === "issue view") console.log("p1\\nautopilot:claimed\\nfeature");
`,
    { mode: 0o755 },
  );
  s = runIn(R, ["bun", `${R}/${EXT}/scripts/ts/create-pr.ts`, "--draft"], {
    PATH: `${bin}:${process.env.PATH}`,
    CLAUDE_CODE_SESSION_ID: "",
    CLAUDE_CODE_BRIDGE_SESSION_ID: "",
  });
  check("create-pr", "exit code", 0, s.rc);
  contains("create-pr", "[OK] Draft PR created: https://example.test/pull/1", s.out);
  const calls = read(log)
    .split("\n")
    .map((l) => JSON.parse(l) as string[]);
  const create = calls.find((c) => c[0] === "pr" && c[1] === "create") ?? [];
  const flag = (f: string) => create[create.indexOf(f) + 1] ?? "";
  check("create-pr", "--draft passed", true, create.includes("--draft"));
  check("create-pr", "title", "#7: Demo thing", flag("--title"));
  check("create-pr", "base", "main", flag("--base"));
  contains("create-pr body", "Closes #7", flag("--body"));
  const edit = calls.find((c) => c[0] === "pr" && c[1] === "edit") ?? [];
  check("create-pr", "labels copied", '["pr","edit","042-demo","--add-label","p1","--add-label","feature"]', JSON.stringify(edit));
  check("create-pr", "pushed to the bare origin as one squashed commit", "1", git(bare, "rev-list", "--count", "main..042-demo"));
  check("create-pr", "excluded path carries no branch change", "", git(bare, "diff", "--name-only", "main", "042-demo", "--", "graphify-out"));
  contains("create-pr squash", "Closes #7", git(bare, "log", "-1", "--pretty=%B", "042-demo"));
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(fail === 0 ? "commit_exclude check: ok" : "commit_exclude check: FAILED");
process.exit(fail);
