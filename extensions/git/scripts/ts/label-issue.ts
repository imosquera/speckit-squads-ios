#!/usr/bin/env bun
// git extension: label-issue.ts
// Apply (creating when missing) the triage labels autopilot's picker reads:
// p0..p3, bug/feature, frontend/backend/integration, plus the mock-first and
// epic markers. Single writer of this vocabulary; keep it in sync with
// PRIORITY_RE / BUG_LABELS in extensions/autopilot/scripts/ts/preflight-issues.ts.
// Each axis is exclusive: setting one value removes its siblings.
//
// Usage:
//   label-issue.ts <issue-number> [--priority p0|p1|p2|p3] [--kind bug|feature]
//                                 [--layer frontend|backend|integration]
//                                 [--mock-first|--no-mock-first] [--epic|--no-epic]
//   label-issue.ts <issue-number> --show      print current triage labels, one per line
// No label flags and no --show is a no-op exit 0.
// Exit codes: 0 ok (or nothing to do), 1 usage/`gh` error.

export {}; // module scope, not a global script

const PRIORITIES = ["p0", "p1", "p2", "p3"];
const KINDS = ["bug", "feature"];
const LAYERS = ["frontend", "backend", "integration"];
const MARKERS = ["mock-first", "epic"];

// Used only when the label does not exist yet; an existing label is never restyled.
const STYLE: Record<string, [string, string]> = {
  p0: ["b60205", "Critical — work this before anything else"],
  p1: ["d93f0b", "High priority"],
  p2: ["fbca04", "Normal priority (autopilot's default when unlabelled)"],
  p3: ["0e8a16", "Low priority — work only when nothing else is pending"],
  bug: ["d73a4a", "Something is broken"],
  feature: ["a2eeef", "New capability or enhancement"],
  frontend: ["1d76db", "UI layer — built against fixtures before the API exists"],
  backend: ["5319e7", "API/data layer — no UI work"],
  integration: ["006b75", "Wires the frontend to the real backend, replacing fixtures"],
  "mock-first": ["c5def5", "Build against static fixtures; no network calls"],
  epic: ["3e4b9e", "Parent of a work breakdown — work the child issues, not this one"],
};

const USAGE = `usage: label-issue.ts <issue-number> [--priority p0|p1|p2|p3] [--kind bug|feature]
                      [--layer frontend|backend|integration]
                      [--mock-first|--no-mock-first] [--epic|--no-epic]
       label-issue.ts <issue-number> --show`;

function die(msg: string): never {
  console.error(`[speckit-git-issue] error: ${msg}`);
  process.exit(1);
}

const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const gh = (...args: string[]) => Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });

// gh label create fails when the label exists (the common case); --force would
// restyle it, so swallow the failure instead.
function ensureLabel(name: string) {
  const [color, desc] = STYLE[name] ?? ["ededed", ""];
  gh("label", "create", name, "--color", color, "--description", desc);
}

let issue = "", priority = "", kind = "", layer = "", mock = "", epic = "", show = false;
const argv = process.argv.slice(2);
const value = (i: number, flag: string, what = "a value") => {
  const v = argv[i + 1];
  if (!v) die(`${flag} needs ${what}`);
  return v;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? "";
  switch (a) {
    case "--priority": priority = lower(value(i++, a)); break;
    case "--kind": kind = lower(value(i++, a)); break;
    case "--layer": layer = lower(value(i++, a)); break;
    case "--mock-first": mock = "on"; break;
    case "--no-mock-first": mock = "off"; break;
    case "--epic": epic = "on"; break;
    case "--no-epic": epic = "off"; break;
    case "--show": show = true; break;
    case "-h": case "--help": console.log(USAGE); process.exit(0);
    default:
      if (a.startsWith("-")) die(`unknown flag: ${a}`);
      if (issue) die(`unexpected argument: ${a}`);
      issue = a.replace(/^#/, "");
  }
}

if (!issue) die("usage: label-issue.ts <issue-number> [--priority pN] [--kind bug|feature] [--layer frontend|backend|integration] [--mock-first] [--epic] [--show]");
if (!/^[0-9]+$/.test(issue)) die(`issue number must be numeric (got '${issue}')`);
if (!Bun.which("gh")) die("gh not found — install it or run 'gh auth login'");

if (show) {
  const known = new Set([...PRIORITIES, ...KINDS, ...LAYERS, ...MARKERS]);
  const r = gh("issue", "view", issue, "--json", "labels", "--jq", ".labels[].name");
  for (const l of lower(r.stdout.toString()).split("\n")) if (known.has(l)) console.log(l);
  process.exit(0);
}

if (!(priority + kind + layer + mock + epic)) process.exit(0);

const add: string[] = [], remove: string[] = [];
function axis(v: string, all: string[], flag: string) {
  if (!v) return;
  if (!` ${all.join(" ")} `.includes(` ${v} `)) die(`${flag} must be one of: ${all.join(" ")}`);
  ensureLabel(v);
  add.push(v);
  remove.push(...all.filter((x) => x !== v));
}
axis(priority, PRIORITIES, "--priority");
axis(kind, KINDS, "--kind");
axis(layer, LAYERS, "--layer");

// Markers are independent of every axis, so they only ever touch themselves.
if (mock === "on") { ensureLabel("mock-first"); add.push("mock-first"); }
if (mock === "off") remove.push("mock-first");
if (epic === "on") { ensureLabel("epic"); add.push("epic"); }
if (epic === "off") remove.push("epic");

if (!add.length && !remove.length) process.exit(0);

const addArgs = add.flatMap((l) => ["--add-label", l]);
const r = gh("issue", "edit", issue, ...addArgs, ...remove.flatMap((l) => ["--remove-label", l]));
if (r.exitCode !== 0) {
  // Removing a label the repo has never had is an error; retry with additions only.
  const out = (r.stdout.toString() + r.stderr.toString()).replace(/\n+$/, "");
  if (!addArgs.length || gh("issue", "edit", issue, ...addArgs).exitCode !== 0) {
    die(`gh issue edit failed for #${issue}: ${out}`);
  }
}

console.log(`[speckit-git-issue] #${issue} labelled: ${add.join(" ") || "(removals only)"}`);
