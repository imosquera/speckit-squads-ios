#!/usr/bin/env bun
// git extension: split-issue.ts
// Split a full-stack tracking issue into frontend (mock-first), backend, and
// wire-up child issues, and keep the parent's work-breakdown block pointing at
// them. The wire-up child carries `Blocked by:` (read by preflight-issues.ts);
// autopilot's layer ordering comes from the labels, not creation order (#56).
//
// Usage:
//   split-issue.ts <parent-issue> --title "<feature title>" \
//       --frontend-body FILE --backend-body FILE [--integration-body FILE] \
//       [--priority p0|p1|p2|p3] [--kind bug|feature] [--dry-run]
//   split-issue.ts <parent-issue> --show     print "<layer> <number>" per child, if split
//
// Idempotent: the parent's sentinel block is the registry of children; a re-run
// edits them instead of opening a second set. Child titles are never edited.
// Exit codes: 0 ok (including "already split, updated in place"), 1 usage/gh error.

import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BEGIN = "<!-- speckit:work-breakdown -->";
const END = "<!-- /speckit:work-breakdown -->";
const LABEL_SCRIPT = join(import.meta.dir, "label-issue.ts");

function die(msg: string): never {
  console.error(`[speckit-git-issue] error: ${msg}`);
  process.exit(1);
}
const warn = (msg: string) => console.error(`[speckit-git-issue] warning: ${msg}`);

const USAGE = `usage: split-issue.ts <parent-issue> --title "<feature title>"
           --frontend-body FILE --backend-body FILE [--integration-body FILE]
           [--priority p0|p1|p2|p3] [--kind bug|feature] [--dry-run]
       split-issue.ts <parent-issue> --show`;

let parent = "", title = "", feBody = "", beBody = "", intBody = "", priority = "", kind = "";
let show = false, dry = false;
const argv = process.argv.slice(2);
const value = (i: number, flag: string, what = "a value") => {
  const v = argv[i + 1];
  if (!v) die(`${flag} needs ${what}`);
  return v;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? "";
  switch (a) {
    case "--title": title = value(i++, a); break;
    case "--frontend-body": feBody = value(i++, a, "a path"); break;
    case "--backend-body": beBody = value(i++, a, "a path"); break;
    case "--integration-body": intBody = value(i++, a, "a path"); break;
    case "--priority": priority = value(i++, a); break;
    case "--kind": kind = value(i++, a); break;
    case "--show": show = true; break;
    case "--dry-run": dry = true; break;
    case "-h": case "--help": console.log(USAGE); process.exit(0);
    default:
      if (a.startsWith("-")) die(`unknown flag: ${a}`);
      if (parent) die(`unexpected argument: ${a}`);
      parent = a.replace(/^#/, "");
  }
}

if (!parent) die("usage: split-issue.ts <parent-issue> --title T --frontend-body F --backend-body F");
if (!/^[0-9]+$/.test(parent)) die(`parent issue number must be numeric (got '${parent}')`);
if (!Bun.which("gh")) die("gh not found — install it or run 'gh auth login'");

const view = Bun.spawnSync(["gh", "issue", "view", parent, "--json", "body", "--jq", ".body"], { stdout: "pipe", stderr: "ignore" });
if (view.exitCode !== 0) die(`could not read issue #${parent}`);
const parentBody = view.stdout.toString().replace(/\n+$/, "");

// sed '\|BEGIN|,\|END|p' (keep=true) or '...d' (keep=false): the end marker is
// looked for from the line after the begin, and an unclosed range runs to EOF.
function sedRange(lines: string[], keep: boolean): string[] {
  const out: string[] = [];
  let inside = false;
  for (const l of lines) {
    const hit: boolean = inside || l.includes(BEGIN);
    if (hit === keep) out.push(l);
    inside = inside ? !l.includes(END) : hit;
  }
  return out;
}

// The parent body is the registry. Prose wraps, so fold indented continuation
// lines onto their bullet first, then take the LAST #N on the matching bullet
// (where the generator writes the child; an earlier "supersedes #12" must lose).
function childOf(layer: string): string {
  const bullets: string[] = [];
  let b = "";
  const flush = () => { if (b) { bullets.push(b); b = ""; } };
  for (const line of sedRange(parentBody.split("\n"), true)) {
    if (/^- \[[ xX]\]/.test(line)) { flush(); b = line; }
    else if (b && /^[ \t\n\v\f\r]+[^ \t\n\v\f\r]/.test(line) && !/^[ \t\n\v\f\r]*-[ \t\n\v\f\r]\[/.test(line)) {
      b += line.replace(/^[ \t\n\v\f\r]+/, " ");
    } else flush();
  }
  flush();
  const re = new RegExp(`^- \\[[ x]\\] ${layer}\\b`, "i");
  const nums = bullets.filter((l) => re.test(l)).flatMap((l) => l.match(/#[0-9]+/g) ?? []);
  return (nums.at(-1) ?? "").slice(1);
}

let fe = childOf("frontend"), be = childOf("backend"), int = childOf("integration");

if (show) {
  if (fe) console.log(`frontend ${fe}`);
  if (be) console.log(`backend ${be}`);
  if (int) console.log(`integration ${int}`);
  process.exit(0);
}

const readable = (p: string) => { try { accessSync(p, constants.R_OK); return true; } catch { return false; } };
if (!title) die("--title is required");
if (!feBody || !readable(feBody)) die("--frontend-body must name a readable file");
if (!beBody || !readable(beBody)) die("--backend-body must name a readable file");
if (intBody && !readable(intBody)) die("--integration-body names an unreadable file");

// Shared triage flags every child inherits from the parent.
const triage = [...(priority ? ["--priority", priority] : []), ...(kind ? ["--kind", kind] : [])];

// Labels are advisory; never fail the split.
function label(issue: string, ...args: string[]) {
  if (dry) return;
  if (!existsSync(LABEL_SCRIPT)) { warn(`label-issue.ts not found at ${LABEL_SCRIPT}`); return; }
  const r = Bun.spawnSync([process.execPath, LABEL_SCRIPT, issue, ...args], { stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) warn(`labelling #${issue} failed — continuing`);
}

const TMP = mkdtempSync(join(tmpdir(), "split-issue-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

function upsert(num: string, ctitle: string, name: string, body: string): string {
  const file = join(TMP, `${name}.md`);
  writeFileSync(file, body);
  if (num) {
    if (dry) return num;
    const r = Bun.spawnSync(["gh", "issue", "edit", num, "--body-file", file], { stdout: "ignore", stderr: "inherit" });
    if (r.exitCode !== 0) die(`gh issue edit failed for child #${num}`);
    return num;
  }
  if (dry) return "NEW";
  const r = Bun.spawnSync(["gh", "issue", "create", "--title", ctitle, "--body-file", file], { stdout: "pipe", stderr: "inherit" });
  if (r.exitCode !== 0) die(`gh issue create failed for '${ctitle}'`);
  const url = r.stdout.toString().replace(/\n+$/, "");
  if (!url) die(`gh issue create returned no URL for '${ctitle}'`);
  const n = url.slice(url.lastIndexOf("/") + 1);
  if (!/^[0-9]+$/.test(n)) die(`could not parse an issue number out of '${url}'`);
  return n;
}

const parentRef = `Parent: #${parent}\n\n`;

fe = upsert(fe, `frontend(mock): ${title}`, "fe", parentRef + readFileSync(feBody, "utf8"));
label(fe, "--layer", "frontend", "--mock-first", ...triage);

be = upsert(be, `backend: ${title}`, "be", parentRef + readFileSync(beBody, "utf8"));
label(be, "--layer", "backend", ...triage);

// Written last because it names its siblings. `Blocked by:` is the exact string
// preflight-issues.ts reads.
const intText = intBody ? readFileSync(intBody, "utf8") : `Wire the frontend built in #${fe} to the backend built in #${be}.

## Functional Requirements

- Replace the static fixtures added by #${fe} with real calls to the API from #${be}.
- Delete the fixture modules and any mock-only branches; no fixture may remain
  reachable from production code paths.
- Reconcile the contract: where the shipped API differs from the shape the mock
  assumed, change one side deliberately and say which in the PR.
- Cover the real states the mock could not: loading, empty, error, and slow
  responses.
`;
int = upsert(int, `wire-up: ${title}`, "int", `${parentRef}Blocked by: #${fe}, #${be}\n\n${intText}`);
label(int, "--layer", "integration", ...triage);

// Replace any previous block so a re-run never stacks two. `epic` parks the
// parent in autopilot's BLOCK set.
const kept = sedRange(parentBody.split("\n"), false).map((l) => `${l}\n`).join("");
const newParent = `${kept}${BEGIN}
## Work breakdown

- [ ] frontend — mock first, fixtures only: #${fe}
- [ ] backend — no UI: #${be}
- [ ] integration — wire-up, blocked by the two above: #${int}

This issue is the parent and is not worked directly.
${END}
`;

if (dry) {
  console.log(`[speckit-git-issue] dry run — parent #${parent} body would become:`);
  process.stdout.write(newParent);
  process.exit(0);
}

const parentFile = join(TMP, "parent.md");
writeFileSync(parentFile, newParent);
if (Bun.spawnSync(["gh", "issue", "edit", parent, "--body-file", parentFile], { stdout: "ignore", stderr: "inherit" }).exitCode !== 0) {
  die(`gh issue edit failed for parent #${parent}`);
}
label(parent, "--epic");

console.log(`[speckit-git-issue] #${parent} split: frontend #${fe} (mock-first), backend #${be}, wire-up #${int}`);
