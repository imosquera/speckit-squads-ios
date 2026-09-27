#!/usr/bin/env bun
// Archive extension: archive-feature.ts
// Move specs/{slug}/ to specs/archive/YYYY-MM-DD-{slug}/, update the changelog,
// and close the source GitHub issue (if recorded).
//
// Usage: archive-feature.ts [--force|-f] [feature_slug]
// Exit 2 means "unchecked tasks" — the command layer prompts on it.
import { dirname, basename } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

let force = false;
const args: string[] = [];
for (const a of process.argv.slice(2)) {
  if (a === "--force" || a === "-f") force = true;
  else args.push(a);
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
function findProjectRoot(dir: string): string | null {
  while (dir !== "/") {
    if (isDir(`${dir}/.specify`) || isDir(`${dir}/.git`)) return dir;
    dir = dirname(dir);
  }
  return null;
}
function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}
function run(cmd: string[], quiet = false): number {
  const io = quiet ? "ignore" : "inherit";
  return Bun.spawnSync(cmd, { stdout: io, stderr: io }).exitCode;
}
// `set -e` parity: a failing git step exits with git's own code.
const must = (cmd: string[]) => {
  const c = run(cmd);
  if (c !== 0) process.exit(c);
};

const repoRoot = findProjectRoot(import.meta.dir) ?? process.cwd();
process.chdir(repoRoot);

if (!Bun.which("git")) die("[archive] git not found");
if (run(["git", "rev-parse", "--is-inside-work-tree"], true) !== 0) die("[archive] not a git repo");

// Slug comes from the branch, never from feature.json (issue #33); only
// source_issue is read from that file. Inlined so archive does not depend on
// the git extension.
let slug = args[0] ?? "";
if (!slug) {
  if (process.env.SPECIFY_FEATURE) slug = process.env.SPECIFY_FEATURE;
  else {
    const r = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    slug = r.stdout.toString().replace(/\n+$/, "").replace(/^.*\//s, "");
  }
}

let sourceIssue = "";
const featureJson = `${repoRoot}/.specify/feature.json`;
if (existsSync(featureJson)) {
  for (const line of readFileSync(featureJson, "utf8").split("\n")) {
    const m = /.*"source_issue"\s*:\s*([0-9]+).*/.exec(line);
    if (m) {
      sourceIssue = m[1] ?? "";
      break;
    }
  }
}

if (!slug || slug === "HEAD") die("[archive] feature slug not provided and could not be derived from the current branch");

const src = `specs/${slug}`;
if (slug.startsWith("archive/")) die(`[archive] ${src} is already under specs/archive/`);
if (!isDir(src)) die(`[archive] source ${src} does not exist`);

const tasksFile = `${src}/tasks.md`;
if (existsSync(tasksFile)) {
  const open = readFileSync(tasksFile, "utf8")
    .split("\n")
    .map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => l.startsWith("- [ ]"));
  if (open.length) {
    if (force) console.error(`[archive] --force: archiving despite ${open.length} unchecked tasks in ${tasksFile}`);
    else {
      console.error(`[archive] refusing to archive: ${tasksFile} has unchecked tasks (use --force to override):`);
      for (const [n, l] of open) console.error(`${n}:${l}`);
      process.exit(2);
    }
  }
}

const now = new Date();
const pad = (n: number) => String(n).padStart(2, "0");
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const dest = `specs/archive/${date}-${slug}`;
if (existsSync(dest)) die(`[archive] destination ${dest} already exists`);

let title = slug;
if (existsSync(`${src}/spec.md`)) {
  const re = /^#\s*Feature Specification:\s*/;
  const h1 = readFileSync(`${src}/spec.md`, "utf8").split("\n").find((l) => re.test(l));
  const t = h1?.replace(re, "");
  if (t) title = t;
}

// Prefer CHANGELOG.md; fall back to CHANGES.md when that is what the repo uses.
const changes = existsSync(`${repoRoot}/CHANGELOG.md`)
  ? `${repoRoot}/CHANGELOG.md`
  : existsSync(`${repoRoot}/CHANGES.md`)
    ? `${repoRoot}/CHANGES.md`
    : `${repoRoot}/CHANGELOG.md`;
const dateH = `## ${date}`;
const section = "### Changed";
let entry = `- ${title} — archived to \`${dest}/\``;
if (sourceIssue) entry += ` (closes #${sourceIssue})`;

if (!existsSync(changes)) {
  writeFileSync(
    changes,
    `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).\n\n${dateH}\n\n${section}\n\n${entry}\n`,
  );
  console.log(`[archive] created ${basename(changes)}`);
} else {
  const text = readFileSync(changes, "utf8");
  // awk record semantics: a trailing newline ends the last record, not a new one.
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  if (lines.includes(dateH)) {
    // Line-for-line port of the bash awk, quirks included.
    let inDate = false;
    let inserted = false;
    for (const l of lines) {
      if (l === dateH) {
        inDate = true;
        out.push(l);
        continue;
      }
      if (inDate && l.startsWith("## ")) {
        if (!inserted) {
          out.push(section, "", entry, "");
          inserted = true;
        }
        inDate = false;
      }
      if (inDate && l === section) {
        out.push(l, "", entry);
        inserted = true;
        inDate = false;
        continue;
      }
      out.push(l);
    }
    if (inDate && !inserted) out.push("", section, "", entry);
    writeFileSync(changes, out.map((l) => `${l}\n`).join(""));
    console.log(`[archive] appended entry under ${date} > Changed`);
  } else {
    let inserted = false;
    for (const l of lines) {
      if (!inserted && l.startsWith("## ")) {
        out.push(dateH, "", section, "", entry, "");
        inserted = true;
      }
      out.push(l);
    }
    if (!inserted) out.push("", dateH, "", section, "", entry);
    writeFileSync(changes, out.map((l) => `${l}\n`).join(""));
    console.log(`[archive] inserted new ${date} section`);
  }
}

must(["git", "add", changes]);
mkdirSync("specs/archive", { recursive: true });
must(["git", "mv", src, dest]);
console.log(`[archive] git mv ${src} -> ${dest}`);

if (sourceIssue) {
  if (Bun.which("gh")) {
    if (run(["gh", "issue", "view", sourceIssue], true) === 0) {
      if (run(["gh", "issue", "close", sourceIssue, "-c", `Archived in \`${dest}/\`. See CHANGES.md (${date}).`]) !== 0)
        console.error(`[archive] warning: failed to close issue #${sourceIssue}`);
      console.log(`[archive] closed issue #${sourceIssue}`);
    } else console.error(`[archive] issue #${sourceIssue} not visible to gh; skipping close`);
  } else console.error(`[archive] gh CLI not found; skipping issue close (#${sourceIssue})`);
} else console.log("[archive] no source_issue in .specify/feature.json; nothing to close");

console.log(`[OK] archived to ${dest}`);
