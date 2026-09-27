#!/usr/bin/env bun
// Checks extensions/autopilot/scripts/ts/bind-feature-issue.ts on temp repos.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = import.meta.dir;
const TS = join(HERE, "extensions/autopilot/scripts/ts/bind-feature-issue.ts");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL: ${name}${detail ? `\n${detail}` : ""}`);
    failures++;
  }
}
const tmps: string[] = [];
function sh(cwd: string, ...cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
}
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "<absent>");

interface Scenario {
  name: string;
  args: (repo: string) => string[];
  cwd?: (repo: string) => string;
  files?: Record<string, string>; // committed before the run
  untracked?: Record<string, string>;
  expect: number;
  verify?: (r: Result) => void;
}
interface Result {
  code: number;
  out: string;
  err: string;
  state: string;
}

function runOne(s: Scenario, script: string): Result {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "bind-repo-")));
  tmps.push(repo);
  sh(repo, "git", "init", "-q", "-b", "042-demo");
  const put = (files: Record<string, string>) => {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(repo, p, ".."), { recursive: true });
      writeFileSync(join(repo, p), c);
    }
  };
  put(s.files ?? {});
  mkdirSync(join(repo, "sub/dir"), { recursive: true });
  writeFileSync(join(repo, "sub/dir/.keep"), "");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  put(s.untracked ?? {});
  const cmd = [process.execPath, script];
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  const r = Bun.spawnSync([...cmd, ...s.args(repo)], { cwd: s.cwd?.(repo) ?? repo, env, stdout: "pipe", stderr: "pipe" });
  const norm = (t: string) => t.replaceAll(repo, "<REPO>");
  const state = [
    `feature.json: ${read(join(repo, ".specify/feature.json"))}`,
    `.gitignore: ${read(join(repo, ".gitignore"))}`,
    `ls-files: ${sh(repo, "git", "ls-files")}`,
    `status: ${sh(repo, "git", "status", "--porcelain", "--untracked-files=all")}`,
  ].join("\n");
  return { code: r.exitCode, out: norm(r.stdout.toString()), err: norm(r.stderr.toString()), state };
}

const scenarios: Scenario[] = [
  { name: "no args", args: () => [], expect: 1, verify: (r) => check("usage", r.err.includes("Usage: bind-feature-issue.ts <issue-number> [worktree-path]")) },
  { name: "non-numeric", args: () => ["12a"], expect: 1, verify: (r) => check("numeric msg", r.err.includes("must be numeric, got: 12a")) },
  { name: "not a worktree", args: () => ["5", "/nonexistent-bind-dir"], expect: 1 },
  {
    name: "fresh repo, explicit path",
    args: (r) => ["42", r],
    expect: 0,
    verify: (r) => {
      check("fresh: json", r.state.includes('feature.json: {"source_issue":42}\n'), r.state);
      check("fresh: ignored", r.state.includes("\n.specify/feature.json\n"), r.state);
      check("fresh: bound line", r.out === "[autopilot] Bound <REPO> to issue #42 (.specify/feature.json, gitignored).\n", r.out);
    },
  },
  { name: "default cwd", args: () => ["43"], expect: 0 },
  { name: "empty path arg uses cwd", args: () => ["44", ""], expect: 0 },
  { name: "subdirectory path", args: (r) => ["45", join(r, "sub/dir")], expect: 0, verify: (r) => check("sub: top level", r.out.includes("Bound <REPO> to")) },
  { name: "invoked from subdirectory", args: () => ["46"], cwd: (r) => join(r, "sub/dir"), expect: 0 },
  {
    name: "inherited tracked feature.json",
    files: { ".specify/feature.json": '{"source_issue":1,"feature_directory":"specs/001-old"}\n' },
    args: (r) => ["47", r],
    expect: 0,
    verify: (r) => check("inherited: untracked + replaced", !r.state.includes("ls-files: .specify/feature.json") && r.state.includes('{"source_issue":47}'), r.state),
  },
  {
    name: "own untracked feature.json keeps feature_directory",
    files: { ".gitignore": "node_modules/\n" },
    untracked: { ".specify/feature.json": '{"feature_directory":"specs/042-demo"}\n' },
    args: (r) => ["48", r],
    expect: 0,
    verify: (r) => check("own: merged", r.state.includes('"feature_directory":"specs/042-demo"') && r.state.includes('"source_issue":48'), r.state),
  },
  { name: "unparseable feature.json", untracked: { ".specify/feature.json": 'not json "feature_directory": "specs/x"\n' }, args: (r) => ["49", r], expect: 0 },
];

try {
  for (const s of scenarios) {
    const t = runOne(s, TS);
    check(`${s.name}: exit ${s.expect}`, t.code === s.expect, `got ${t.code}\n${t.err}`);
    s.verify?.(t);
  }
} finally {
  for (const p of tmps) rmSync(p, { recursive: true, force: true });
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log(`test-bind-feature-issue: ${scenarios.length} scenarios OK`);
