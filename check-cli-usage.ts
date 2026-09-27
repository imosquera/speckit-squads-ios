#!/usr/bin/env bun
// Install pre-flight. Exit 1 on any failure (install.ts aborts on it).
//   1. every `specify <verb> [<subverb>]` inside a fenced block of a command file
//      exists in the installed CLI (skipped with a warning when specify is absent)
//   2. scripts/check-script-paths.ts: declared scripts exist; every script path a
//      command file references resolves and is declared; the core
//      `.specify/scripts/bash/` tree is flat; no bare $CLAUDE_PROJECT_DIR in a bash
//      block (issue #59); no reference to a retired scripts/bash/*.sh of ours
//   3. `bun run typecheck`, when node_modules is installed
//
// Usage: ./check-cli-usage.ts
import { existsSync, readFileSync } from "node:fs";
import { cmp, commandFiles } from "./scripts/manifest.ts";

const REPO_DIR = import.meta.dir;
process.chdir(REPO_DIR);

const out = (cmd: string[]): string =>
  Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" }).stdout.toString();
const onPath = (bin: string): boolean => Bun.which(bin) !== null;

/** Command names from a `specify ... --help` Commands panel (rich box drawing). */
function verbsOf(...args: string[]): string[] {
  const verbs: string[] = [];
  let inPanel = false;
  for (const line of out(["specify", ...args, "--help"]).split("\n")) {
    // sed -n '/Commands/,/╰/p': the end pattern is only tested after the start line.
    if (!inPanel) {
      if (!line.includes("Commands")) continue;
      inPanel = true;
    } else if (line.includes("╰")) inPanel = false;
    const m = /^│ ([a-z][a-z-]*)/.exec(line);
    if (m?.[1]) verbs.push(m[1]);
  }
  return verbs;
}

let skipCli = false;
if (!onPath("specify")) {
  console.error("warn: specify CLI not on PATH — skipping CLI surface check");
  skipCli = true;
}
const topVerbs = skipCli ? [] : verbsOf();
if (!skipCli && topVerbs.length === 0) {
  console.error("warn: could not parse `specify --help` — skipping CLI surface check");
  skipCli = true;
}

const files = [...commandFiles("extensions").sort(cmp), ...commandFiles("presets").sort(cmp)];
if (files.length === 0) process.exit(0);

let fail = false;

/** file, line, verb, subverb for each `specify` invocation inside a ``` fence. */
function* scan(): Generator<[string, number, string, string]> {
  const INV = /(^|[^A-Za-z0-9_./-])specify[ \t\r\n\f\v]+[a-z][a-z-]*([ \t\r\n\f\v]+[a-z][a-z-]*)?/;
  let inFence = false; // like the awk it replaces: not reset between files
  for (const file of files) {
    const text = readFileSync(file, "utf8").split("\n");
    if (text.at(-1) === "") text.pop();
    for (const [i, raw] of text.entries()) {
      if (/^[ \t\r\n\f\v]*```/.test(raw)) {
        inFence = !inFence;
        continue;
      }
      if (!inFence) continue;
      let line = raw;
      for (let m = INV.exec(line); m; m = INV.exec(line)) {
        line = line.slice(m.index + m[0].length);
        const w = m[0].replace(/^[^s]*/, "").split(/[ \t\r\n\f\v]+/);
        yield [file, i + 1, w[1] ?? "", w[2] ?? ""];
      }
    }
  }
}

if (!skipCli) {
  const subCache = new Map<string, string[]>();
  for (const [file, line, verb, sub] of scan()) {
    if (!verb) continue;
    if (!topVerbs.includes(verb)) {
      console.error(`${file}:${line}: unknown \`specify ${verb}\` — not a CLI command`);
      fail = true;
      continue;
    }
    if (!sub) continue;
    if (!subCache.has(verb)) subCache.set(verb, verbsOf(verb));
    const subverbs = subCache.get(verb) ?? [];
    // A verb with no subcommand panel takes free-form args; nothing to check.
    if (subverbs.length === 0) continue;
    if (!subverbs.includes(sub)) {
      console.error(`${file}:${line}: unknown \`specify ${verb} ${sub}\` — valid: ${subverbs.join(" ")} `);
      fail = true;
    }
  }
}

const bun = (...args: string[]): number | null =>
  Bun.spawnSync([process.execPath, ...args], { stdio: ["inherit", "inherit", "inherit"] }).exitCode;
if (bun("scripts/check-script-paths.ts") !== 0) fail = true;

// Guarded: install pre-flight may run in a checkout that never ran `bun install`.
if (!existsSync("node_modules/.bin/tsc")) {
  console.error("warn: node_modules missing — run `bun install` here; skipping TypeScript typecheck");
} else if (bun("run", "--silent", "typecheck") === 0) {
  console.log("typecheck: ok");
} else {
  console.error("error: `bun run typecheck` failed");
  fail = true;
}

if (fail) {
  console.error("error: pre-flight checks failed");
  process.exit(1);
}
console.log(`CLI surface check: ok (${files.length} command files)`);
