#!/usr/bin/env bun
// Git extension: render-spec.ts
//
// Render a feature's spec.md into the region of its tracking issue body that
// sync-issue-body.ts owns: a `Spec path:` line, the spec with its H1 and any
// omitted `## <heading>` sections dropped, and a trailing `## Notes` footer.
// sync-issue-body.ts is the only caller; the preservation surgery stays there.
//
// Usage: render-spec.ts <spec-path> [<omit-heading>]...
// Exit codes: 0 rendered to stdout, 1 spec unreadable or not valid UTF-8.

import { readFileSync } from "node:fs";

const [spec, ...omitArgs] = process.argv.slice(2);
if (spec === undefined) {
  console.error("usage: render-spec.ts <spec-path> [<omit-heading>]...");
  process.exit(1);
}
const omit = new Set(omitArgs.map((a) => a.trim().toLowerCase()));

let text: string;
try {
  text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(spec));
} catch (e) {
  console.error(`render-spec: cannot read ${spec}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// Python str.splitlines(): every Unicode line boundary, no trailing empty line.
function splitlines(s: string): string[] {
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

const out: string[] = [];
let skipping = false;
let seenH1 = false;
for (const line of splitlines(text)) {
  const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
  if (m) {
    const level = (m[1] ?? "").length;
    const title = m[2] ?? "";
    if (level === 1 && !seenH1) {
      seenH1 = true; // the H1 is the template heading, not a section
      continue;
    }
    if (level === 2) skipping = omit.has(title.toLowerCase());
  }
  if (!skipping) out.push(line);
}
const body = out.join("\n").replace(/^\n+|\n+$/g, "");
process.stdout.write(
  `Spec path: ${spec}\n\n${body}\n\n## Notes\n\nGenerated/updated by /speckit-git-issue\n`,
);
