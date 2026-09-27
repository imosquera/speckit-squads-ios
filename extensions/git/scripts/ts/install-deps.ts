#!/usr/bin/env bun
// Git extension: install-deps.ts — install a fresh linked worktree's dependencies (issue #51).
//
// The base checkout is the oracle: a directory is installed here only if the same
// directory there already has node_modules/ (or .venv/). The package manager is read
// off the lockfile, never assumed to be npm. Best effort: every path exits 0.
//
// Usage: install-deps.ts <worktree-path>     Env: SPECKIT_SKIP_INSTALL=1 skips entirely

import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const say = (s: string) => console.error(`[specify] install-deps: ${s}`);
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const arg = process.argv[2] ?? "";
if (!arg || !isDir(arg)) {
  say(`no such worktree '${arg}'; skipping dependency install`);
  process.exit(0);
}
if (process.env.SPECKIT_SKIP_INSTALL === "1") {
  say("SPECKIT_SKIP_INSTALL=1; skipping dependency install");
  process.exit(0);
}
const WT = resolve(arg);

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", WT, ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString() : "";
}

// Base checkout = the main worktree. Everything after "worktree " (paths may hold spaces).
const first = git("worktree", "list", "--porcelain", "-z").split("\0")[0] || git("worktree", "list", "--porcelain").split("\n")[0] || "";
const BASE = first.startsWith("worktree ") ? first.slice(9) : "";
if (!BASE || !isDir(BASE)) {
  say("could not resolve the base checkout; skipping dependency install");
  process.exit(0);
}
// Physical paths: git reports /private/var/..., the caller usually passes /var/....
if (realpathSync(BASE) === realpathSync(WT)) process.exit(0); // not a linked worktree

// ---- discovery: tracked manifests, deduplicated to their directories ("." for the root)
const manifestDirs = [
  ...new Set(
    git("ls-files")
      .split("\n")
      .filter((f) => /(^|\/)(package\.json|uv\.lock|poetry\.lock)$/.test(f))
      .map((f) => f.replace(/[^/]+$/, "").replace(/\/$/, "") || "."),
  ),
].sort();
if (!manifestDirs.length) process.exit(0);

const NODE_LOCKS = ["bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"];
const has = (dir: string, f: string) => existsSync(`${dir}/${f}`) && !isDir(`${dir}/${f}`);

// Nearest ancestor (self first) with a node lockfile: a workspace installs its children
// from the root, and a child's own `npm install` would race the root's pnpm install.
function nodeInstallRoot(rel: string): string {
  for (let r = rel; ; r = dirname(r)) {
    if (NODE_LOCKS.some((l) => has(`${WT}/${r}`, l))) return r;
    if (r === ".") return rel;
  }
}
function planNode(abs: string): string {
  if (has(abs, "bun.lockb") || has(abs, "bun.lock")) return "bun install";
  if (has(abs, "pnpm-lock.yaml")) return "pnpm install --frozen-lockfile";
  if (has(abs, "yarn.lock")) return "yarn install --frozen-lockfile";
  if (has(abs, "package-lock.json")) return "npm ci";
  return "npm install";
}

const plan: { rel: string; cmd: string }[] = [];
let skippedNoTool = "";
for (let rel of manifestDirs) {
  let abs = `${WT}/${rel}`;
  const baseAbs = `${BASE}/${rel}`;
  if (!isDir(abs)) continue;
  let cmd = "";
  if (has(abs, "package.json")) {
    // pnpm keeps node_modules in both; npm workspaces hoist to the root only.
    const rootRel = nodeInstallRoot(rel);
    if (isDir(`${baseAbs}/node_modules`) || isDir(`${BASE}/${rootRel}/node_modules`)) {
      rel = rootRel;
      abs = `${WT}/${rel}`;
      cmd = planNode(abs);
    }
  } else if (has(abs, "uv.lock") && isDir(`${baseAbs}/.venv`)) cmd = "uv sync";
  else if (has(abs, "poetry.lock") && isDir(`${baseAbs}/.venv`)) cmd = "poetry install";
  if (!cmd || plan.some((p) => p.rel === rel)) continue;

  const tool = cmd.split(" ")[0]!;
  if (!Bun.which(tool)) {
    skippedNoTool += ` ${rel}(${tool})`;
    continue;
  }
  plan.push({ rel, cmd });
}

if (skippedNoTool) say(`not on PATH, skipped:${skippedNoTool}`);
if (!plan.length) process.exit(0);

// ---- run them concurrently; one line of summary, details only on failure
const logdir = mkdtempSync(`${tmpdir()}/install-deps-`);
say(`installing dependencies in ${plan.length} director${plan.length === 1 ? "y" : "ies"} ...`);
const results = await Promise.all(
  plan.map(async ({ rel, cmd }, i) => {
    const cwd = resolve(WT, rel);
    const fd = openSync(`${logdir}/${i}.log`, "w");
    try {
      // PWD matches the bash subshell's `cd`, so tools see the logical path.
      const p = Bun.spawn(cmd.split(" "), { cwd, env: { ...process.env, PWD: cwd }, stdin: "ignore", stdout: fd, stderr: fd });
      return (await p.exited) === 0;
    } catch {
      return false;
    } finally {
      closeSync(fd);
    }
  }),
);

const ok = plan.filter((_, i) => results[i]).map((p) => ` ${p.rel}`).join("");
if (ok) say(`installed:${ok}`);
plan.forEach(({ rel, cmd }, i) => {
  if (results[i]) return;
  say(`FAILED in ${rel}: ${cmd} — run it by hand before implementing`);
  const log = readFileSync(`${logdir}/${i}.log`, "utf8").replace(/\n$/, "");
  if (log) console.error(log.split("\n").slice(-15).map((l) => `    ${l}`).join("\n"));
});
rmSync(logdir, { recursive: true, force: true });
