#!/usr/bin/env bun
// install-deps.ts installs a fresh worktree's dependencies at creation and stays out
// of the way: no manifest is a silent no-op, a failing package manager never fails the
// caller, and a directory the base checkout never installed is never installed (#51).
// Usage: ./test-worktree-deps.ts
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";

const SCRIPT = `${import.meta.dir}/extensions/git/scripts/ts/install-deps.ts`;
const TMP = mkdtempSync(`${tmpdir()}/worktree-deps-`);
const CALLS = `${TMP}/calls.log`;
let fail = 0;

function check(what: string, desc: string, expected: string, actual: string): void {
  if (expected === actual) console.log(`  ok: ${what} ${desc}`);
  else {
    console.error(`  FAIL: ${what} ${desc} — expected '${expected}', got '${actual}'`);
    fail = 1;
  }
}
function contains(what: string, needle: string, hay: string): void {
  if (hay.includes(needle)) console.log(`  ok: ${what} mentions '${needle}'`);
  else {
    console.error(`  FAIL: ${what} does not mention '${needle}'`);
    console.error(hay.split("\n").map((l) => `        ${l}`).join("\n"));
    fail = 1;
  }
}
function absent(what: string, needle: string, hay: string): void {
  if (hay.includes(needle)) {
    console.error(`  FAIL: ${what} unexpectedly mentions '${needle}'`);
    fail = 1;
  } else console.log(`  ok: ${what} does not mention '${needle}'`);
}

const git = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "ignore", stderr: "ignore" });
function makeRepo(name: string, files: Record<string, string> = {}): string {
  const repo = `${TMP}/${name}`;
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(`${repo}/README.md`, "hi\n");
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(`${repo}/${f}`), { recursive: true });
    writeFileSync(`${repo}/${f}`, body);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "one");
  return repo;
}
// slugify: a repo dir may contain a space, a branch name may not
const addWt = (repo: string) => (git(repo, "worktree", "add", "-q", "-b", `feat-${basename(repo).replaceAll(" ", "-")}`, `${repo}.wt`), `${repo}.wt`);
const nodeModules = (repo: string, ...dirs: string[]) => dirs.forEach((d) => mkdirSync(`${repo}/${d}/node_modules`, { recursive: true }));

// A fake package manager that records its invocations, or fails on demand.
function fakeBin(dir: string, name: string, code: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}`, `#!/usr/bin/env bash\necho "$(pwd) ${name} $*" >> "${CALLS}"\necho "boom" >&2\nexit ${code}\n`);
  chmodSync(`${dir}/${name}`, 0o755);
}
const resetCalls = () => writeFileSync(CALLS, "");
const calls = () => readFileSync(CALLS, "utf8").replace(/\n+$/, "");
// bun by absolute path, so a PATH without bun still runs the script (case 5).
function run(args: string[], env: Record<string, string> = {}): { out: string; rc: number } {
  const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { out: (r.stdout.toString() + r.stderr.toString()).replace(/\n+$/, ""), rc: r.exitCode ?? -1 };
}
const withBin = (bin: string) => ({ PATH: `${bin}:${process.env.PATH}` });
const PKG = { "package.json": '{"name":"x"}\n' };

try {
  console.log("1. no manifest anywhere -> silent no-op, exit 0");
  let WT = addWt(makeRepo("nomanifest"));
  let r = run([WT]);
  check("no-manifest", "exit code", "0", String(r.rc));
  check("no-manifest", "output", "", r.out);

  console.log("2. manifest the base checkout never installed -> not installed here");
  WT = addWt(makeRepo("uninstalled", { ...PKG, "package-lock.json": "" }));
  resetCalls();
  fakeBin(`${TMP}/bin2`, "npm", 0);
  r = run([WT], withBin(`${TMP}/bin2`));
  check("uninstalled", "exit code", "0", String(r.rc));
  check("uninstalled", "ran no installer", "", calls());

  console.log("3. base has node_modules -> the lockfile picks the package manager");
  let REPO = makeRepo("installed", {
    ...PKG,
    "package-lock.json": "",
    "web/package.json": '{"name":"w"}\n',
    "web/pnpm-lock.yaml": "",
    "docs/package.json": '{"name":"d"}\n',
  });
  nodeModules(REPO, ".", "web"); // docs/ never installed
  WT = addWt(REPO);
  resetCalls();
  fakeBin(`${TMP}/bin3`, "npm", 0);
  fakeBin(`${TMP}/bin3`, "pnpm", 0);
  r = run([WT], withBin(`${TMP}/bin3`));
  check("installed", "exit code", "0", String(r.rc));
  contains("root install", `${WT} npm ci`, calls());
  contains("workspace install", `${WT}/web pnpm install --frozen-lockfile`, calls());
  absent("docs (base never installed it)", `${WT}/docs`, calls());
  contains("summary", "installed:", r.out);

  console.log("4. a failing install reports but does not fail the caller");
  REPO = makeRepo("failing", { ...PKG, "package-lock.json": "" });
  nodeModules(REPO, ".");
  WT = addWt(REPO);
  fakeBin(`${TMP}/bin4`, "npm", 1);
  r = run([WT], withBin(`${TMP}/bin4`));
  check("failing", "exit code", "0", String(r.rc));
  contains("failing", "FAILED in", r.out);

  console.log("5. package manager missing from PATH -> named, not run, still exit 0");
  REPO = makeRepo("notool", { ...PKG, "bun.lockb": "" });
  nodeModules(REPO, ".");
  WT = addWt(REPO);
  r = run([WT], { PATH: "/nonexistent-bin-dir:/usr/bin:/bin" });
  check("no-tool", "exit code", "0", String(r.rc));
  contains("no-tool", "bun", r.out);

  console.log("6. SPECKIT_SKIP_INSTALL=1 skips everything");
  resetCalls();
  fakeBin(`${TMP}/bin6`, "npm", 0);
  r = run([`${TMP}/installed.wt`], { SPECKIT_SKIP_INSTALL: "1", ...withBin(`${TMP}/bin6`) });
  check("skip", "exit code", "0", String(r.rc));
  contains("skip", "SPECKIT_SKIP_INSTALL=1", r.out);
  check("skip", "ran no installer", "", calls());

  console.log("7. a missing / non-worktree path is a warning, never an error");
  r = run([`${TMP}/does-not-exist`]);
  check("missing-path", "exit code", "0", String(r.rc));
  contains("missing-path", "no such worktree", r.out);
  check("no-arg", "exit code", "0", String(run([]).rc));

  console.log("8. the base checkout itself is never installed into");
  resetCalls();
  fakeBin(`${TMP}/bin8`, "npm", 0);
  r = run([`${TMP}/installed`], withBin(`${TMP}/bin8`));
  check("base-checkout", "exit code", "0", String(r.rc));
  check("base-checkout", "ran no installer", "", calls());

  console.log("9. a pnpm workspace child is installed by its root, never on its own");
  REPO = makeRepo("workspace", { ...PKG, "pnpm-lock.yaml": "", "packages/api/package.json": '{"name":"api"}\n' });
  nodeModules(REPO, ".", "packages/api");
  WT = addWt(REPO);
  resetCalls();
  fakeBin(`${TMP}/bin9`, "pnpm", 0);
  fakeBin(`${TMP}/bin9`, "npm", 0);
  r = run([WT], withBin(`${TMP}/bin9`));
  check("workspace", "exit code", "0", String(r.rc));
  contains("workspace root", `${WT} pnpm install --frozen-lockfile`, calls());
  absent("workspace child", "packages/api", calls());
  check("workspace", "installs once", "1", String(calls().split("\n").filter(Boolean).length));

  console.log("10. a base checkout whose path contains a space still resolves");
  REPO = makeRepo("spaced repo", { ...PKG, "package-lock.json": "" });
  nodeModules(REPO, ".");
  WT = addWt(REPO);
  resetCalls();
  fakeBin(`${TMP}/bin10`, "npm", 0);
  r = run([WT], withBin(`${TMP}/bin10`));
  check("spaced", "exit code", "0", String(r.rc));
  absent("spaced", "could not resolve the base checkout", r.out);
  contains("spaced", `${WT} npm ci`, calls());
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

if (fail === 0) console.log("worktree deps check: ok");
else console.error("worktree deps check: FAILED");
process.exit(fail);
