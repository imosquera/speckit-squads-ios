#!/usr/bin/env bun
// Checks extensions/archive/scripts/ts/archive-feature.ts on temp repos with a stub gh.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = import.meta.dir;
const TS = join(HERE, "extensions/archive/scripts/ts/archive-feature.ts");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL: ${name}${detail ? `\n${detail}` : ""}`);
    failures++;
  }
}
const tmps: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmps.push(d);
  return d;
};
function sh(cwd: string, ...cmd: string[]): void {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
}

// Stub gh: logs argv; GH_VIEW_FAIL / GH_CLOSE_FAIL force failures.
const stubBin = tmp("archive-gh-");
writeFileSync(
  join(stubBin, "gh"),
  `#!/bin/sh\necho "gh $*" >> "$GH_LOG"\ncase "$2" in view) [ -z "$GH_VIEW_FAIL" ];; close) [ -z "$GH_CLOSE_FAIL" ] && echo "closed stub";; esac\n`,
);
chmodSync(join(stubBin, "gh"), 0o755);

const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

interface Scenario {
  name: string;
  branch?: string;
  files?: Record<string, string>;
  setup?: (repo: string) => void;
  args?: string[];
  env?: Record<string, string>;
  noGh?: boolean;
  expect: number;
  verify?: (r: Result) => void;
}
interface Result {
  code: number;
  out: string;
  err: string;
  tree: string;
  gh: string;
}

function tree(dir: string, rel = ""): string[] {
  const acc: string[] = [];
  for (const n of readdirSync(join(dir, rel)).sort()) {
    const p = rel ? `${rel}/${n}` : n;
    if (p === ".git" || p === ".specify/extensions") continue;
    if (statSync(join(dir, p)).isDirectory()) acc.push(`${p}/`, ...tree(dir, p));
    else acc.push(`== ${p}\n${readFileSync(join(dir, p), "utf8")}`);
  }
  return acc;
}

function runOne(s: Scenario, script: string): Result {
  const repo = tmp("archive-repo-");
  sh(repo, "git", "init", "-q", "-b", s.branch ?? "042-demo");
  for (const [p, c] of Object.entries(s.files ?? {})) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  s.setup?.(repo);
  // The script finds its project root by walking up from its own location.
  const dest = join(repo, ".specify/extensions/archive/scripts/ts");
  mkdirSync(dest, { recursive: true });
  cpSync(script, join(dest, script.split("/").pop()!));
  const log = join(repo, "..", `${repo.split("/").pop()}.ghlog`);
  tmps.push(log);
  const cmd = [process.execPath, join(dest, "archive-feature.ts")];
  const env: Record<string, string> = { HOME: process.env.HOME ?? "", GH_LOG: log, PATH: `${s.noGh ? "" : `${stubBin}:`}/usr/bin:/bin`, ...s.env };
  const r = Bun.spawnSync([...cmd, ...(s.args ?? [])], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo, stdout: "pipe" }).stdout.toString();
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
    tree: `${tree(repo).join("\n")}\n-- status\n${status}`,
    gh: existsSync(log) ? readFileSync(log, "utf8") : "",
  };
}

const spec = "# Feature Specification: Demo Thing\n\nbody\n";
const done = "- [x] T001 a\n- [x] T002 b\n";
const base = { "specs/042-demo/spec.md": spec, "specs/042-demo/tasks.md": done };
const withIssue = { ...base, ".specify/feature.json": '{"source_issue":7,"feature_directory":"specs/042-demo"}\n' };
const header = "# Changelog\n\nIntro.\n\n";
const cl = (r: Result) => r.tree.slice(r.tree.indexOf("== CHANGELOG.md"));

const scenarios: Scenario[] = [
  {
    name: "fresh changelog, closes issue",
    files: withIssue,
    expect: 0,
    verify: (r) => {
      check("fresh: moved", r.tree.includes(`specs/archive/${today}-042-demo/spec.md`));
      check("fresh: entry", r.tree.includes(`- Demo Thing — archived to \`specs/archive/${today}-042-demo/\` (closes #7)`));
      check("fresh: gh close", r.gh.includes("gh issue close 7 -c"));
      check("fresh: ok line", r.out.endsWith(`[OK] archived to specs/archive/${today}-042-demo\n`));
    },
  },
  { name: "no feature.json", files: base, expect: 0, verify: (r) => check("nofj: notice", r.out.includes("nothing to close") && r.gh === "") },
  {
    name: "CHANGES.md with older section",
    files: { ...base, "CHANGES.md": `${header}## 2000-01-01\n\n### Added\n\n- old\n` },
    expect: 0,
    verify: (r) => check("older: inserted", r.out.includes(`inserted new ${today} section`) && !r.tree.includes("== CHANGELOG.md")),
  },
  {
    name: "today section with Changed",
    files: { ...base, "CHANGELOG.md": `${header}## ${today}\n\n### Changed\n\n- earlier\n\n## 2000-01-01\n\n- old\n` },
    expect: 0,
    verify: (r) => check("changed: appended", cl(r).includes(`### Changed\n\n- Demo Thing`)),
  },
  { name: "today section without Changed", files: { ...base, "CHANGELOG.md": `${header}## ${today}\n\n### Added\n\n- x\n\n## 2000-01-01\n\n- old\n` }, expect: 0 },
  { name: "today section at EOF, no newline", files: { ...base, "CHANGELOG.md": `${header}## ${today}\n\n### Fixed\n\n- x` }, expect: 0 },
  { name: "changelog without headings", files: { ...base, "CHANGELOG.md": "just text" }, expect: 0 },
  {
    name: "unchecked tasks refused",
    files: { ...base, "specs/042-demo/tasks.md": "- [x] T1\n- [ ] T2 open\n- [ ] T3 open\n" },
    expect: 2,
    verify: (r) => check("unchecked: list", r.err.includes("2:- [ ] T2 open\n3:- [ ] T3 open")),
  },
  { name: "unchecked tasks forced", files: { ...base, "specs/042-demo/tasks.md": "- [ ] T2\n" }, args: ["--force"], expect: 0 },
  { name: "unchecked tasks -f with slug", files: { ...base, "specs/042-demo/tasks.md": "- [ ] T2\n" }, branch: "main", args: ["042-demo", "-f"], expect: 0 },
  { name: "already archived", files: base, args: ["archive/x"], expect: 1 },
  { name: "missing source", files: base, args: ["999-nope"], expect: 1 },
  { name: "destination exists", files: { ...base, [`specs/archive/${today}-042-demo/x`]: "x\n" }, expect: 1 },
  { name: "prefixed branch", branch: "feat/042-demo", files: base, expect: 0 },
  { name: "SPECIFY_FEATURE wins", branch: "main", files: base, env: { SPECIFY_FEATURE: "042-demo" }, expect: 0 },
  { name: "detached HEAD", files: base, setup: (r) => sh(r, "git", "checkout", "-q", "--detach"), expect: 1 },
  { name: "spec without title", files: { ...base, "specs/042-demo/spec.md": "# Other\n" }, expect: 0, verify: (r) => check("notitle: slug", r.tree.includes("- 042-demo — archived")) },
  { name: "gh view fails", files: withIssue, env: { GH_VIEW_FAIL: "1" }, expect: 0, verify: (r) => check("view: skip", r.err.includes("not visible to gh")) },
  { name: "gh close fails", files: withIssue, env: { GH_CLOSE_FAIL: "1" }, expect: 0, verify: (r) => check("close: warn", r.err.includes("failed to close issue #7")) },
  { name: "no gh on PATH", files: withIssue, noGh: true, expect: 0, verify: (r) => check("nogh: notice", r.err.includes("gh CLI not found")) },
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
console.log(`test-archive-feature: ${scenarios.length} scenarios OK`);
