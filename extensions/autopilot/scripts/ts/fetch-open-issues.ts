#!/usr/bin/env bun
// Fetch the open-issue backlog to a FILE, oldest-first, for preflight-issues.ts.
// A file, not stdin: piping data into a stdin-heredoc script silently loses it.
// Usage: fetch-open-issues.ts <output-file>

import { closeSync, openSync, statSync } from "node:fs";

const out = process.argv[2];
if (!out) {
  process.stderr.write("usage: fetch-open-issues.ts <output-file>\n");
  process.exit(1);
}

let ok = false;
try {
  const fd = openSync(out, "w");
  try {
    ok = Bun.spawnSync(["gh", "issue", "list", "--state", "open", "--limit", "200",
      "--json", "number,title,labels,createdAt,assignees,body", "--jq", "sort_by(.createdAt)"],
      { stdout: fd, stderr: "inherit" }).exitCode === 0;
  } finally {
    closeSync(fd);
  }
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
}
if (!ok) {
  process.stderr.write("gh issue list failed — run 'gh auth status' and confirm a GitHub remote\n");
  process.exit(1);
}
if (statSync(out).size === 0) {
  process.stderr.write("gh returned no data — treat as a failure, not an empty backlog\n");
  process.exit(1);
}
