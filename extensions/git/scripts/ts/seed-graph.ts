#!/usr/bin/env bun
// Git extension: seed-graph.ts — build a fresh worktree's knowledge graph.
//
// Untracked graph -> graphify-out/ goes in info/exclude so a rebuild is never committed.
// Tracked graph   -> left visible; earlier runs that hid it are healed.
// No graph tracked and none in the main checkout -> skipped (the project keeps none).
// Best effort: every path exits 0 (a missing tool is a warning, never a failed caller).
//
// Usage: seed-graph.ts <worktree-path>     Env: SPECKIT_SKIP_GRAPH=1 skips entirely

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const say = (s: string) => console.error(`[specify] seed-graph: ${s}`);
const wt = process.argv[2] ?? "";
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readLines = (p: string): string[] | null => {
  try {
    return readFileSync(p, "utf8").split("\n");
  } catch {
    return null;
  }
};
function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", wt, ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().replace(/\n+$/, "") : "";
}

if (!wt || !isDir(wt)) {
  say(`no such worktree '${wt}'; skipping graph build`);
  process.exit(0);
}
if (process.env.SPECKIT_SKIP_GRAPH === "1") {
  say("SPECKIT_SKIP_GRAPH=1; skipping graph build");
  process.exit(0);
}
if (!Bun.which("graphify")) {
  say("graphify not on PATH; skipping graph build");
  process.exit(0);
}

// Only where the project keeps a graph: tracked at HEAD, or present in the main checkout (#118).
const mainCheckout = /^worktree (.*)/.exec(git("worktree", "list", "--porcelain").split("\n")[0] ?? "")?.[1] ?? "";
if (!git("ls-files", "--", "graphify-out") && !isDir(`${mainCheckout}/graphify-out`)) {
  say("project keeps no graph; skipping graph build");
  process.exit(0);
}

// ---- graphify-out and git (before the rebuild writes anything)
const commonRel = Bun.which("git") ? git("rev-parse", "--git-common-dir") : "";
if (commonRel) {
  const common = resolve(wt, commonRel);
  const exclude = `${common}/info/exclude`;
  const hasStanza = () => (readLines(exclude) ?? []).includes("graphify-out/");

  if (!git("ls-files", "--", "graphify-out")) {
    try {
      mkdirSync(`${common}/info`, { recursive: true });
      if (!hasStanza()) {
        appendFileSync(
          exclude,
          "\n# Local knowledge graph — rebuilt per worktree, not tracked by this repo.\n# Excluded so a rebuild is never committed by accident.\ngraphify-out/\n",
        );
      }
    } catch {}
  } else {
    // Heal: remove our own stanza, and skip-worktree bits in THIS worktree's index.
    if (hasStanza()) {
      Bun.spawnSync([process.execPath, `${import.meta.dir}/unexclude-graph.ts`, exclude], { stdout: 2, stderr: "inherit" });
    }
    const skipped = git("ls-files", "-v", "--", "graphify-out")
      .split("\n")
      .filter((l) => l.startsWith("S "))
      .map((l) => l.slice(2));
    if (skipped.length && Bun.spawnSync(["git", "-C", wt, "update-index", "--no-skip-worktree", "--", ...skipped], { stderr: "ignore" }).exitCode !== 0) {
      say("could not clear skip-worktree on tracked graphify-out files");
    }
    say("graphify-out/ is tracked here — left tracked and visible (no exclude, no skip-worktree)");
    if (git("ls-files", "--", "graphify-out/.graphify_root")) {
      say("WARNING: graphify-out/.graphify_root is committed. It holds an absolute");
      console.error("  checkout path that graphify's post-commit/post-checkout hooks rebuild, so every checkout");
      console.error("  rebuilds whichever worktree last committed it. Fix: `git rm --cached graphify-out/.graphify_root`");
      console.error("  and add graphify-out/.graphify_root to .gitignore (graphify rewrites it on every build and");
      console.error("  falls back to the checkout root when it is absent).");
    }
  }
}

say(`building knowledge graph for ${wt} ...`);
if (Bun.spawnSync(["graphify", "update", wt], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) {
  say(`graph ready at ${wt}/graphify-out`);
} else {
  say(`'graphify update ${wt}' failed; run it by hand before navigating`);
}
