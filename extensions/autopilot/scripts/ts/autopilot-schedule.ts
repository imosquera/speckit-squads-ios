#!/usr/bin/env bun
// Manage the per-repo launchd agent that runs one autopilot pass on an interval.
// Opt-in, macOS only. Usage text is in HELP below.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, type } from "node:os";
import { basename, dirname, join } from "node:path";

const HELP = `Manage a launchd agent that runs /speckit-autopilot-run on a fixed interval,
so the backlog drains itself without a human kicking off each pass.

NOT scheduled by default — the user opts in by running \`install\`. One agent per
git repo (labelled by repo), so several projects can each be scheduled
independently. macOS only (launchd).

Subcommands:
  install [--interval-hours N] [--project DIR]   schedule (default N=2, DIR=cwd)
  uninstall [--project DIR]                       unschedule + remove the plist
  status  [--project DIR]                         is it loaded? interval, log tail
  run-now [--project DIR]                          fire one pass immediately
  label   [--project DIR]                          print this repo's launchd label

The interval is configurable: re-run \`install --interval-hours N\` to change it
(the agent is reloaded so the new cadence takes effect right away).
`;

const RUNNER = join(import.meta.dir, "autopilot-run.ts");
const DEFAULT_INTERVAL_HOURS = "2";

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function run(argv: string[], quiet = false): number {
  return Bun.spawnSync(argv, { stdout: quiet ? "ignore" : "inherit", stderr: quiet ? "ignore" : "inherit" }).exitCode;
}

function requireMacos(): void {
  if (type() !== "Darwin") die(`launchd scheduling is macOS-only (got ${type()}).`);
}

function projectRoot(dir: string): string {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: dir || process.cwd(), stdout: "pipe", stderr: "ignore" });
    const out = r.stdout.toString().replace(/\n+$/, "");
    if (r.exitCode === 0) return out;
  } catch { /* cwd missing */ }
  die(`not inside a git repo: ${dir || process.cwd()}`);
}

// Readable-but-unique slug so two repos with the same basename don't collide.
// autopilot-run.ts imports this so its raw log stays a sibling of the decoded log.
export function slugFor(root: string): string {
  const base = basename(root).replace(/[^A-Za-z0-9._-]/g, "-");
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 6);
  return `${base}-${hash}`;
}
const labelFor = (root: string) => `com.speckit.autopilot.${slugFor(root)}`;
const plistFor = (root: string) => `${homedir()}/Library/LaunchAgents/${labelFor(root)}.plist`;
export const logFor = (root: string) => `${homedir()}/Library/Logs/speckit-autopilot/${slugFor(root)}.log`;

function parseCommon(args: string[]): { project: string; hours: string } {
  let project = process.cwd();
  let hours = DEFAULT_INTERVAL_HOURS;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const val = args[i + 1];
    if (flag === "--project") project = val || die("--project needs a path");
    else if (flag === "--interval-hours") hours = val || die("--interval-hours needs a number");
    else die(`unknown arg: ${flag}`);
  }
  return { project, hours };
}

function install(args: string[]): void {
  requireMacos();
  const { project, hours } = parseCommon(args);
  if (!/^[0-9]+$/.test(hours) || parseInt(hours, 10) < 1) die("--interval-hours must be a positive integer (hours)");
  if (!existsSync(RUNNER)) die(`runner not found: ${RUNNER}`);

  const root = projectRoot(project);
  const label = labelFor(root), plist = plistFor(root), log = logFor(root);
  const seconds = parseInt(hours, 10) * 3600;
  const uid = process.getuid!();
  const home = homedir();
  // launchd starts with a minimal PATH: bun is pinned by absolute path, and PATH
  // spells out where claude/gh/git live. PATH lookup first: execPath is a
  // version-specific Cellar path that `brew upgrade bun` deletes.
  const bun = Bun.which("bun") ?? process.execPath;
  const pathEnv = `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bun}</string>
    <string>${RUNNER}</string>
    <string>${root}</string>
  </array>
  <key>StartInterval</key><integer>${seconds}</integer>
  <key>RunAtLoad</key><false/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${pathEnv}</string>
    <key>HOME</key><string>${home}</string>
  </dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`);

  // Reload so a changed interval takes effect; fall back to load/unload on older macOS.
  if (run(["launchctl", "bootout", `gui/${uid}/${label}`], true) !== 0) run(["launchctl", "unload", plist], true);
  if (run(["launchctl", "bootstrap", `gui/${uid}`, plist], true) !== 0 && run(["launchctl", "load", plist]) !== 0) {
    die(`launchctl failed to load ${plist}`);
  }

  console.log(`scheduled  ${label}`);
  console.log(`  every    ${hours}h (StartInterval=${seconds}s)`);
  console.log(`  repo     ${root}`);
  console.log(`  plist    ${plist}`);
  console.log(`  log      ${log}`);
  console.log(`  note     RunAtLoad is off — first pass fires in ~${hours}h; use 'run-now' to trigger one immediately.`);
}

function uninstall(args: string[]): void {
  requireMacos();
  const root = projectRoot(parseCommon(args).project);
  const label = labelFor(root), plist = plistFor(root);
  if (run(["launchctl", "bootout", `gui/${process.getuid!()}/${label}`], true) !== 0) run(["launchctl", "unload", plist], true);
  rmSync(plist, { force: true });
  console.log(`unscheduled ${label} (plist removed)`);
}

function status(args: string[]): void {
  requireMacos();
  const root = projectRoot(parseCommon(args).project);
  const label = labelFor(root), plist = plistFor(root), log = logFor(root);

  const loaded = run(["launchctl", "print", `gui/${process.getuid!()}/${label}`], true) === 0
    || Bun.spawnSync(["launchctl", "list"], { stdout: "pipe", stderr: "inherit" }).stdout.toString().includes(label);
  if (loaded) {
    console.log(`SCHEDULED  ${label}`);
  } else {
    console.log(`NOT SCHEDULED  ${label}`);
    console.log(`  schedule it with: install --interval-hours N --project ${root}`);
  }
  if (existsSync(plist)) {
    // First number on the StartInterval line or the one after it.
    const lines = readFileSync(plist, "utf8").split("\n");
    const i = lines.findIndex((l) => l.includes("StartInterval"));
    const n = i < 0 ? "" : (lines.slice(i, i + 2).join("\n").match(/[0-9]+/)?.[0] ?? "");
    console.log(`  plist  ${plist}  (interval ${n}s)`);
  }
  if (existsSync(log)) {
    console.log(`  log    ${log}`);
    console.log("  --- last log lines ---");
    const tail = Bun.spawnSync(["tail", "-n", "5", log], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
    if (tail) for (const l of tail.replace(/\n$/, "").split("\n")) console.log(`  ${l}`);
  }
}

function runNow(args: string[]): void {
  requireMacos();
  const root = projectRoot(parseCommon(args).project);
  const label = labelFor(root);
  if (Bun.spawnSync(["launchctl", "kickstart", "-k", `gui/${process.getuid!()}/${label}`], { stdout: "inherit", stderr: "ignore" }).exitCode !== 0) {
    die("not scheduled yet — run 'install' first");
  }
  console.log(`kicked off one pass for ${label} (watch ${logFor(root)})`);
}

if (import.meta.main) {
  const [sub = "", ...rest] = process.argv.slice(2);
  switch (sub) {
    case "install": install(rest); break;
    case "uninstall": uninstall(rest); break;
    case "status": status(rest); break;
    case "run-now": runNow(rest); break;
    case "label": process.stdout.write(labelFor(projectRoot(parseCommon(rest).project))); break; // no trailing newline, as before
    case "": case "help": case "-h": case "--help": process.stdout.write(HELP); break;
    default: die(`unknown subcommand: ${sub} (try: install | uninstall | status | run-now | label)`);
  }
}
