#!/usr/bin/env bun
// Durably park a GitHub issue so autopilot stops re-picking it.
// Usage: park-issue.ts <issue-number> <one-line reason> [--title <comment title>]
// The SINGLE writer of the park (skill body and autopilot-run.ts both call it);
// preflight-issues.ts reads the label and the AUTOPILOT-BLOCKED: sentinel back.
// Parking is not closing: closing stays a human's call.

export {}; // a module, so its top-level names stay file-local

const LABEL = "autopilot:blocked";
const SENTINEL = "AUTOPILOT-BLOCKED:";
const USAGE = "[autopilot] Usage: park-issue.ts <issue-number> <reason> [--title <t>]";

function fail(...lines: string[]): never {
  for (const l of lines) process.stderr.write(`${l}\n`);
  process.exit(1);
}

let n = "";
let reason = "";
let title = "🚫 **Autopilot hard blocker**";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--title") {
    if (i + 1 >= args.length) fail("[autopilot] Error: --title needs a value");
    title = args[++i]!;
  } else if (a.startsWith("-")) {
    fail(`[autopilot] Error: unknown option: ${a}`, USAGE);
  } else if (!n) {
    n = a.replace(/^#/, "");
  } else {
    reason = reason ? `${reason} ${a}` : a;
  }
}

if (!n || !reason) fail(USAGE);
if (!/^[0-9]+$/.test(n)) fail(`[autopilot] Error: bad issue number: ${n}`);
if (!Bun.which("gh")) fail(`[autopilot] Error: gh CLI not found; cannot park #${n}`);

// ONE line: preflight replays everything after the sentinel out of context.
reason = reason.replaceAll("\n", " ");

// Already parked → no duplicate comment (the common case on a timer).
const labels = Bun.spawnSync(["gh", "issue", "view", n, "--json", "labels", "-q", ".labels[].name"], { stdout: "pipe", stderr: "ignore" });
if (labels.stdout.toString().split("\n").includes(LABEL)) {
  process.stderr.write(`[autopilot] #${n} already parked (${LABEL}); leaving the existing reason in place\n`);
  process.exit(0);
}

Bun.spawnSync(["gh", "label", "create", LABEL, "--color", "b60205",
  "--description", "Autopilot hit a hard blocker; do not re-pick until resolved"], { stdout: "inherit", stderr: "ignore" });

const body = `${title} — parking this issue; autopilot will not re-pick it until a human clears the \`${LABEL}\` label.\n\n${SENTINEL} ${reason}`;
for (const argv of [["gh", "issue", "comment", n, "--body", body], ["gh", "issue", "edit", n, "--add-label", LABEL]]) {
  const code = Bun.spawnSync(argv, { stdout: "ignore", stderr: "inherit" }).exitCode;
  if (code !== 0) process.exit(code);
}

process.stderr.write(`[OK] parked #${n} — ${reason}\n`);
