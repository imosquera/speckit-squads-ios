#!/usr/bin/env bun
// Git extension: unexclude-graph.ts
//
// Remove the graphify-out/ stanza seed-graph.ts (or the graph-first-navigation
// preset) once wrote to info/exclude — our own stanza only, matched by the same
// expression pre-uninstall.ts uses. seed-graph.ts calls it when the repo tracks
// its graph, which must then stay visible.
//
// Usage: unexclude-graph.ts <info-exclude-path>
// Prints one line when it removed the stanza; silent when there was none.

import { readFileSync, writeFileSync } from "node:fs";

const p = process.argv[2];
if (p === undefined) {
  console.error("usage: unexclude-graph.ts <info-exclude-path>");
  process.exit(1);
}
const t = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(p));
const updated = t.replace(/\n*# Local knowledge graph[^\n]*\n# [^\n]*\ngraphify-out\/\n/g, "\n");
if (updated !== t) {
  writeFileSync(p, updated, "utf-8");
  console.log(`[specify] seed-graph: removed our graphify-out/ exclusion from ${p} (the repo tracks its graph)`);
}
