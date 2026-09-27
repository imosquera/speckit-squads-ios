#!/usr/bin/env bun
// Checks extensions/git/scripts/ts/git-common.ts (and initialize-repo.ts) against temp git repos.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as gc from "./extensions/git/scripts/ts/git-common.ts";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) {
    console.error(`FAIL: ${name}`);
    failures++;
  }
}
function sh(cwd: string, ...cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}
function newRepo(branch = "042-demo"): string {
  const d = mkdtempSync(join(tmpdir(), "git-common-"));
  sh(d, "git", "init", "-q", "-b", branch);
  sh(d, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return d;
}
const tmps: string[] = [];
const repo = (b?: string) => {
  const d = newRepo(b);
  tmps.push(d);
  return d;
};
// Silence the library's expected stderr chatter.
const realError = console.error;
const quiet = <T>(f: () => T): T => {
  console.error = () => {};
  try {
    return f();
  } finally {
    console.error = realError;
  }
};

try {
  // Pure helpers
  check("effective strips one prefix", gc.effectiveBranchName("feat/004-x") === "004-x");
  check("effective keeps 3 segments", gc.effectiveBranchName("a/b/c") === "a/b/c");
  check("num sequential", gc.featureNumFromBranch("014-slug") === "014");
  check("num timestamp", gc.featureNumFromBranch("feat/20260319-143022-slug") === "20260319-143022");
  check("num none", gc.featureNumFromBranch("main") === "");
  check("branch ok", quiet(() => gc.checkFeatureBranch("001-x", true)));
  check("branch timestamp ok", quiet(() => gc.checkFeatureBranch("20260319-143022-x", true)));
  check("branch bad", !quiet(() => gc.checkFeatureBranch("main", true)));
  check("malformed timestamp bad", !quiet(() => gc.checkFeatureBranch("20260319-143022", true)));
  check("no git skips", quiet(() => gc.checkFeatureBranch("main", false)));
  check("jsonEscape", gc.jsonEscape('a"b\\c') === 'a\\"b\\\\c');

  // hasGit / sidecar
  const r = repo();
  const plain = mkdtempSync(join(tmpdir(), "git-common-plain-"));
  tmps.push(plain);
  check("hasGit repo", gc.hasGit(r));
  check("hasGit plain", !gc.hasGit(plain));
  check("sidecar path", gc.sourceIssueSidecar(r)?.endsWith("/.git/speckit-source-issue") === true);
  check("sidecar outside git", gc.sourceIssueSidecar(plain) === null);

  // write / read / recover (mirrors test-feature-json.ts)
  const json = `${r}/.specify/feature.json`;
  check("write ok", quiet(() => gc.writeFeatureJson(r, "78")));
  check("read 78", gc.featureSourceIssue(r) === "78");
  check("sidecar written", readFileSync(gc.sourceIssueSidecar(r)!, "utf8") === "78\n");
  check("gitignored", readFileSync(`${r}/.gitignore`, "utf8").split("\n").includes(".specify/feature.json"));
  writeFileSync(json, '{"feature_directory":"specs/042-demo"}\n'); // core's clobber
  check("recovered after clobber", quiet(() => gc.featureSourceIssue(r)) === "78");
  check("file healed", JSON.parse(readFileSync(json, "utf8")).source_issue === 78);
  check("relink", quiet(() => gc.writeFeatureJson(r, "99")) && gc.featureSourceIssue(r) === "99");
  check("dir write keeps issue", quiet(() => gc.writeFeatureDirectory(r, 'specs/q"x')));
  check("merged shape", readFileSync(json, "utf8") === '{"feature_directory":"specs/q\\"x","source_issue":99}\n');
  check("non-numeric refused", !quiet(() => gc.writeFeatureJson(r, "abc")));
  // printf fallback path: unparseable file
  writeFileSync(json, 'garbage "source_issue": 7, "feature_directory": "specs/a\\"b"\n');
  quiet(() => gc.writeFeatureJson(r, "", "specs/new"));
  check("fallback rebuild", readFileSync(json, "utf8") === '{"source_issue":7,"feature_directory":"specs/new"}\n');
  rmSync(json);
  rmSync(gc.sourceIssueSidecar(r)!);
  check("no phantom issue", gc.featureSourceIssue(r) === "");
  const gi = readFileSync(`${r}/.gitignore`, "utf8");
  gc.ignoreFeatureJson(r);
  check("ignore idempotent", readFileSync(`${r}/.gitignore`, "utf8") === gi);

  // tracked (inherited) feature.json is purged and untracked
  const t = repo();
  mkdirSync(`${t}/.specify`);
  writeFileSync(`${t}/.specify/feature.json`, '{"source_issue":5}\n');
  writeFileSync(`${t}/.gitignore`, "node_modules"); // no trailing newline
  sh(t, "git", "add", "-A");
  sh(t, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "tracked");
  quiet(() => gc.writeFeatureDirectory(t, "specs/042-demo"));
  check("inherited issue dropped", gc.featureSourceIssue(t) === "");
  check("untracked", sh(t, "git", "ls-files", ".specify/feature.json") === "");
  check("gitignore newline fixed", readFileSync(`${t}/.gitignore`, "utf8").startsWith("node_modules\n# Per-worktree"));

  // resolveFeature
  const f = repo("feat/042-demo");
  mkdirSync(`${f}/specs/042-demo`, { recursive: true });
  quiet(() => gc.writeFeatureJson(f, "42"));
  const id = gc.resolveFeature(`${f}/specs`);
  check("resolve branch", id?.branch === "feat/042-demo");
  check("resolve num", id?.num === "042");
  check("resolve dir", id?.directory === "specs/042-demo");
  check("resolve issue", id?.sourceIssue === "42");
  check("resolve worktree", id?.worktree === sh(f, "git", "rev-parse", "--show-toplevel"));
  process.env.SPECIFY_FEATURE_DIRECTORY = "specs/pinned";
  check("env dir override", gc.resolveFeature(f)?.directory === "specs/pinned");
  delete process.env.SPECIFY_FEATURE_DIRECTORY;
  check("resolve outside git", gc.resolveFeature(plain) === null);

  // commitExcludes
  check("no config", gc.commitExcludes(f).length === 0);
  mkdirSync(`${f}/.specify/extensions/git`, { recursive: true });
  writeFileSync(
    `${f}/.specify/extensions/git/git-config.yml`,
    "auto_commit:\n  default: false\ncommit_exclude:\n  - graphify-out/   # generated\n  - \"dist/\"\n  - 'a b'\n# comment\nother: 1\n  - not-this\n",
  );
  check("excludes", JSON.stringify(gc.commitExcludes(f)) === '["graphify-out/","dist/","a b"]');

  // initialize-repo.ts in a fresh project
  const p = mkdtempSync(join(tmpdir(), "git-common-init-"));
  tmps.push(p);
  mkdirSync(`${p}/.specify/extensions/git/scripts/ts`, { recursive: true });
  for (const n of ["initialize-repo.ts", "git-common.ts"])
    cpSync(`${import.meta.dir}/extensions/git/scripts/ts/${n}`, `${p}/.specify/extensions/git/scripts/ts/${n}`);
  writeFileSync(`${p}/.specify/extensions/git/git-config.yml`, 'init_commit_message: "hello init"\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const run = () => Bun.spawnSync(["bun", `${p}/.specify/extensions/git/scripts/ts/initialize-repo.ts`], { cwd: "/", env, stdout: "pipe", stderr: "pipe" });
  const r1 = run();
  check("init exit 0", r1.exitCode === 0);
  check("init stderr", r1.stderr.toString() === "✓ Git repository initialized\n" && r1.stdout.toString() === "");
  check("init commit msg", sh(p, "git", "log", "-1", "--format=%s") === "hello init");
  check("init gitignore", readFileSync(`${p}/.gitignore`, "utf8").includes(".specify/feature.json"));
  const r2 = run();
  check("init rerun skips", r2.exitCode === 0 && r2.stderr.toString() === "[specify] Git repository already initialized; skipping\n");
} finally {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: git-common");
