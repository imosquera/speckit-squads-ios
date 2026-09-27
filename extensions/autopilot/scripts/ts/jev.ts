#!/usr/bin/env bun
// jev.ts — answers speckit-squads' bounded judgment calls with Jev (TypeSafe's
// System One model) through @typesafe-ai/sdk. The agent still does the work;
// this only replaces the classification pauses around it.
//
// This file (scripts/jev.ts) is the canonical copy. Every item that asks Jev
// ships a byte-identical copy at scripts/ts/jev.ts, because each item installs
// into a consumer on its own; check-script-paths.ts fails on a drifted copy.
//
// Usage:
//   jev.ts <case> --<arg> VALUE ...      one judgment (cases listed in CASES)
//   jev.ts measure [--case C] --records FILE.jsonl
// A file argument may be `-` for stdin (at most one per call).
//
// Prints one JSON line. `verdict` is Jev's confident answer (null when unsure),
// `decision` is the verdict when it may be acted on, and `record` goes in the
// caller's report so a wrong auto-decision can be traced.
//
// Exit codes:
//   0  decided: act on `decision`
//   3  fall back to the caller's non-Jev behaviour, unchanged: SPECKIT_JEV=off,
//      no TYPESAFE_API_KEY, no SDK, any API error, confidence under 0.85,
//      `none_of_these`, or a gated verdict in shadow mode. A shadowed `verdict`
//      may still be shown to a human as the recommended answer.
//   2  usage error
//
// Shadow mode: a gated verdict (red-reason, duplicate, finding=false_positive)
// decides only when its case is listed in SPECKIT_JEV_AUTOMATE (comma-separated,
// or `all`), after `measure` has replayed past records. TDD_JEV_AUTOMATE_RED=1
// still lifts red-reason.
//
// The API key comes from TYPESAFE_API_KEY, else the user's key file
// ($XDG_CONFIG_HOME/typesafe/key, then ~/.typesafe_key): Jev is on wherever that
// file exists. The key is never printed, logged, or accepted as an argument.

import type { TypeSafeClient as Client } from "@typesafe-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SDK = "@typesafe-ai/sdk";
const SDK_VERSION = "0.6.0";
const DECIDE = 0.85; // at or above: automate. Below: today's behaviour.
const LIMIT = 8000; // chars per state field; keeps each call fast
const OK = 0, FALLBACK = 3, USAGE = 2;

type Arg = { key: string; file?: "head" | "tail" };
type ChoiceQ = { type: "choice"; instructions: string; criteria: Record<string, string>; fold?: Record<string, string> };
type NoulQ = { type: "noul"; instructions: string; yes: [string, string]; no: [string, string]; always?: boolean };
type Case = { args: Record<string, Arg>; q: ChoiceQ | NoulQ; gated?: true | string[]; tag?: string };

const noul = (instructions: string, yes: [string, string], no: [string, string], always = false): NoulQ =>
  ({ type: "noul", instructions, yes, no, always });

// One bounded question per judgment. Every criterion is one sentence with no
// "and"/"or"; every Choice carries none_of_these. A Noul decides at p >= 0.85
// (yes) or p <= 0.15 (no); `always` makes anything short of yes a no.
const NONE = "No other option fits.";
const CASES: Record<string, Case> = {
  // ------------------------------------------------------------ tdd preset
  "red-reason": {
    args: { scenario: { key: "scenario" }, test: { key: "test_source", file: "head" }, output: { key: "suite_output", file: "tail" } },
    gated: true,
    q: {
      type: "choice",
      instructions: "The new test in `test_source` was just run as part of the suite. Which option describes its result in `suite_output`?",
      // A missing symbol under test is expected Red, but it also never reaches an
      // assertion: one "behavior missing" option lost it to harness_error at 0.86.
      // Separate options for each shape, folded back into expected_red.
      criteria: {
        expected_red: "An assertion in the test fails.",
        missing_code: "The test cannot run because the function under test does not exist yet.",
        missing_module: "The test cannot run because the file under test does not exist yet.",
        harness_error: "A defect in the test file itself stops the test.",
        passes_immediately: "The test passes.",
        none_of_these: "No other option describes the result.",
      },
      fold: { missing_code: "expected_red", missing_module: "expected_red" },
    },
  },
  baseline: {
    args: { failure: { key: "failing_test_output", file: "tail" }, baseline: { key: "baseline_run", file: "tail" } },
    q: noul("Was the test failing in `failing_test_output` passing in `baseline_run`?",
      ["regression", "The baseline run shows this test passing."],
      ["baseline_failure", "The baseline run shows this test failing."]),
  },
  covers: {
    args: { scenario: { key: "scenario" }, test: { key: "test", file: "head" } },
    q: noul("Does `test` exercise `scenario`?",
      ["covered", "The test checks the behavior the scenario describes."],
      ["flag", "The test checks some other behavior."], true),
  },
  exempt: {
    args: { path: { key: "path" }, diff: { key: "diff", file: "head" } },
    tag: "path",
    q: noul("Is the file at `path` untestable: docs, pure configuration, or generated output?",
      ["exempt", "The file holds no executable logic."],
      ["refused", "The file holds logic a test could exercise."], true),
  },
  // ------------------------------------------------------------ git extension
  duplicate: {
    args: { new: { key: "new_issue", file: "head" }, candidate: { key: "candidate_issue", file: "head" } },
    tag: "candidate",
    gated: ["duplicate"],
    q: noul("Would resolving `candidate_issue` also resolve `new_issue`?",
      ["duplicate", "Fixing one issue would resolve the other."],
      ["distinct", "The two issues describe different problems."]),
  },
  priority: {
    args: { issue: { key: "issue", file: "head" } },
    q: {
      type: "choice",
      instructions: "How urgent is the work `issue` describes?",
      criteria: {
        p0: "The issue reports an emergency that blocks everyone right now.",
        p1: "The issue reports a user-facing feature that is broken with no workaround.",
        p2_defect: "The issue reports an ordinary defect that has a workaround.",
        p2_feature: "The issue asks for an ordinary new capability.",
        p3: "The issue asks for polish that nothing depends on.",
        none_of_these: NONE,
      },
      fold: { p2_defect: "p2", p2_feature: "p2" },
    },
  },
  kind: {
    args: { issue: { key: "issue", file: "head" } },
    q: {
      type: "choice",
      instructions: "What kind of work does `issue` describe?",
      criteria: {
        bug: "The issue describes behavior that is broken today.",
        feature: "The issue asks for a capability that does not exist yet.",
        none_of_these: NONE,
      },
    },
  },
  layer: {
    args: { spec: { key: "spec", file: "head" } },
    q: {
      type: "choice",
      instructions: "Which layers do the requirements in `spec` change?",
      criteria: {
        frontend: "Every requirement concerns what the user sees on screen.",
        backend: "Every requirement concerns server logic behind an API.",
        full_stack: "The requirements need changes on both sides of an API.",
        no_layer: "The requirements touch no user interface, no network API.",
        none_of_these: NONE,
      },
    },
  },
  // ------------------------------------------------------------ autopilot
  "fast-path": {
    args: { issue: { key: "issue", file: "head" }, change: { key: "planned_change", file: "head" } },
    q: {
      type: "choice",
      instructions: "Given `issue` and the agent's `planned_change` after reading the code, how big is the change?",
      criteria: {
        fast_path: "The change alters one behavior in at most three files.",
        structural: "The change adds a dependency, a schema change, an API change, a migration, a new screen, or a wide rename.",
        ambiguous: "The issue leaves open what exactly to change.",
        none_of_these: NONE,
      },
      fold: { structural: "full_pipeline", ambiguous: "full_pipeline" },
    },
  },
  // ------------------------------------------------------------ review
  finding: {
    args: { finding: { key: "finding", file: "head" }, code: { key: "code", file: "head" } },
    gated: ["false_positive"],
    q: {
      type: "choice",
      instructions: "A reviewer reported `finding` about `code`. Which option describes the finding?",
      criteria: {
        defect: "The finding names code that behaves wrongly.",
        style: "The finding names code that works but could read better.",
        false_positive: "The finding is wrong about what the code does.",
        none_of_these: NONE,
      },
    },
  },
  "same-finding": {
    args: { a: { key: "finding_a", file: "head" }, b: { key: "finding_b", file: "head" } },
    q: noul("Do `finding_a` and `finding_b` report the same problem?",
      ["same", "Both findings point at the same underlying problem."],
      ["distinct", "The findings point at different problems."]),
  },
  // ------------------------------------------------------------ stale-tasks-guard
  "spec-change": {
    args: { diff: { key: "spec_diff", file: "head" } },
    q: noul("Does `spec_diff` change what the feature must do?",
      ["requirement", "The diff changes a requirement."],
      ["wording", "The diff only changes wording."]),
  },
  // ------------------------------------------------------------ preset applicability
  "applies-ui": {
    args: { spec: { key: "spec", file: "head" } },
    q: noul("Does `spec` change a user interface?",
      ["applies", "The spec changes what a user sees on screen."],
      ["skip", "The spec changes nothing a user sees on screen."]),
  },
  "applies-library": {
    args: { plan: { key: "plan", file: "head" } },
    q: noul("Does `plan` build something a library could provide?",
      ["applies", "The plan hand-rolls a general-purpose capability."],
      ["skip", "The plan builds only logic specific to this project."]),
  },
};

type Out = {
  case: string; source: "jev" | "fallback"; decision: string | null; verdict?: string | null;
  answer?: string | number; raw?: string; confidence?: number; model?: string; reason?: string; record: string;
};

function emit(out: Out, code: number): never {
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(code);
}

function usage(msg: string): never {
  process.stderr.write(`jev: ${msg}\n`);
  process.exit(USAGE);
}

// ---------------------------------------------------------------- arguments
const [cmd, ...rest] = process.argv.slice(2);
const args: Record<string, string> = {};
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i], v = rest[i + 1];
  if (!k?.startsWith("--") || v === undefined) usage(`bad argument near ${k ?? "(end)"}`);
  args[k.slice(2)] = v;
}
let stdinUsed = false;
function need(name: string): string {
  const v = args[name];
  if (v === undefined || v === "") usage(`${cmd} needs --${name}`);
  return v;
}
const clip = (text: string, keep: "head" | "tail") => text.length <= LIMIT ? text
  : keep === "head" ? text.slice(0, LIMIT) + "\n…[truncated]" : "…[truncated]\n" + text.slice(-LIMIT);
function file(name: string, keep: "head" | "tail"): string {
  const p = need(name);
  if (p === "-") {
    if (stdinUsed) usage("only one argument may read stdin");
    stdinUsed = true;
  }
  try {
    return clip(readFileSync(p === "-" ? 0 : p, "utf8"), keep);
  } catch (e) {
    usage(`cannot read --${name} ${p}: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- the SDK
// Resolved at runtime, never bundled: the project's own copy, then one beside
// this script (a speckit-squads checkout), then a machine-level cache that the
// first use fills with bun. Never .specify/ (consumers commit it) and never the
// project's dependency list. None found is a fallback, not an error.
const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "speckit-squads", "jev");

// Only asks Bun to resolve from a directory whose node_modules really holds the
// SDK: from anywhere else, bun auto-installs whatever the registry has.
function resolveSdk(): string | undefined {
  for (const start of [process.cwd(), dirname(import.meta.path), CACHE]) {
    for (let dir = start; ; dir = dirname(dir)) {
      if (existsSync(join(dir, "node_modules", SDK, "package.json"))) {
        try { return Bun.resolveSync(SDK, dir); } catch { break; }
      }
      if (dir === dirname(dir)) break;
    }
  }
}

function installSdk(): void {
  try {
    mkdirSync(CACHE, { recursive: true });
    if (!existsSync(join(CACHE, "package.json"))) writeFileSync(join(CACHE, "package.json"), '{"private":true}\n');
    Bun.spawnSync([process.execPath, "add", "--silent", `${SDK}@${SDK_VERSION}`],
      { cwd: CACHE, stdout: "ignore", stderr: "ignore", timeout: 60_000 });
  } catch { /* resolveSdk reports it */ }
}

async function client(caseName: string): Promise<Client> {
  const fallback: (reason: string) => never = reason =>
    emit({ case: caseName, source: "fallback", decision: null, reason, record: `jev ${caseName}: unavailable (${reason})` }, FALLBACK);
  if (process.env.SPECKIT_JEV === "off") fallback("SPECKIT_JEV=off");
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    // No key in the environment (launchd, a shell that never sourced a profile):
    // read the user's key file, into this process's env only, never printed.
    const home = homedir(), config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    for (const p of [join(config, "typesafe", "key"), join(home, ".typesafe_key")]) {
      try {
        const key = readFileSync(p, "utf8").trim();
        if (key) { process.env.TYPESAFE_API_KEY = key; break; }
      } catch { /* next */ }
    }
  }
  if (!process.env.TYPESAFE_API_KEY?.trim()) fallback("no TYPESAFE_API_KEY");
  let path = resolveSdk();
  if (!path) { installSdk(); path = resolveSdk(); }
  if (!path) fallback(`${SDK} not installed`);
  try {
    const mod = (await import(path)) as typeof import("@typesafe-ai/sdk");
    return new mod.TypeSafeClient({ timeout: 15_000, retry: { maxRetries: 1 } });
  } catch (e) {
    fallback(`sdk: ${(e as Error).message}`);
  }
}

let sdk: Client | undefined;
type Answer = { model: string; verdict: string | null; answer: string | number; raw?: string; confidence: number };

// Asks one case. Choice: gate on the verdict's summed probability after the
// fold, not the top raw option's. Noul: confidence is distance toward the side.
async function ask(name: string, c: Case, state: Record<string, string>): Promise<Answer> {
  sdk ??= await client(name);
  const q = c.q.type === "choice"
    ? { type: "choice" as const, instructions: c.q.instructions, criteria: c.q.criteria }
    : { type: "noul" as const, instructions: c.q.instructions, criteria: { true: c.q.yes[1], false: c.q.no[1] } };
  let r;
  try {
    r = await sdk.systemOne({ state, questions: { q } });
  } catch (e) {
    const err = e as Error & { status?: number };
    const reason = `api error: ${err.name}${err.status ? ` ${err.status}` : ""}`;
    emit({ case: name, source: "fallback", decision: null, reason, record: `jev ${name}: ${reason}` }, FALLBACK);
  }
  const a = r.answers.q;
  if (c.q.type === "choice") {
    if (a.type !== "choice") throw new Error(`expected a choice answer, got ${a.type}`);
    const fold = c.q.fold ?? {};
    const p: Record<string, number> = {};
    for (const [k, v] of Object.entries(a.probabilities)) p[fold[k] ?? k] = (p[fold[k] ?? k] ?? 0) + v;
    const choice = Object.keys(p).reduce((best, k) => ((p[k] ?? 0) > (p[best] ?? 0) ? k : best));
    const confidence = p[choice] ?? 0;
    const verdict = confidence >= DECIDE && choice !== "none_of_these" ? choice : null;
    return { model: r.model, verdict, answer: choice, raw: a.choice, confidence };
  }
  if (a.type !== "noul") throw new Error(`expected a noul answer, got ${a.type}`);
  const pYes = a.noul;
  const verdict = pYes >= DECIDE ? c.q.yes[0] : c.q.always || pYes <= 1 - DECIDE ? c.q.no[0] : null;
  return { model: r.model, verdict, answer: pYes, confidence: pYes >= 0.5 ? pYes : 1 - pYes };
}

function automated(name: string): boolean {
  const list = (process.env.SPECKIT_JEV_AUTOMATE ?? "").split(",").map(s => s.trim());
  return list.includes("all") || list.includes(name) || (name === "red-reason" && process.env.TDD_JEV_AUTOMATE_RED === "1");
}

const pct = (x: number) => x.toFixed(2);

// ---------------------------------------------------------------- commands
if (cmd === "measure") {
  // Replays past records to decide whether a gated case may automate. One JSON
  // object per line: each of the case's --arg names holding the argument's
  // *content* (not a path), plus `label`, the right verdict.
  const name = args.case ?? "red-reason";
  const c = CASES[name] ?? usage(`unknown case ${name}`);
  const labels = c.q.type === "choice"
    ? [...new Set(Object.keys(c.q.criteria).map(k => (c.q.type === "choice" && c.q.fold?.[k]) || k))]
    : [c.q.yes[0], c.q.no[0]];
  const lines = file("records", "head").split("\n").filter(l => l.trim());
  if (!lines.length) usage("--records holds no records");
  let agree = 0, confident = 0, confidentAgree = 0;
  for (const [i, line] of lines.entries()) {
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line); } catch { usage(`record ${i + 1} is not JSON`); }
    const state: Record<string, string> = {};
    for (const [flag, a] of Object.entries(c.args)) {
      const v = rec[flag];
      if (typeof v !== "string") usage(`record ${i + 1} needs string ${Object.keys(c.args).join(", ")} and a label in ${labels.join("|")}`);
      state[a.key] = a.file ? clip(v, a.file) : v;
    }
    if (typeof rec.label !== "string" || !labels.includes(rec.label)) usage(`record ${i + 1} needs a label in ${labels.join("|")}`);
    const a = await ask(name, c, state);
    const said = a.verdict ?? (typeof a.answer === "string" ? a.answer : null);
    if (said === rec.label) agree++;
    if (a.verdict) { confident++; if (a.verdict === rec.label) confidentAgree++; }
  }
  const n = lines.length;
  process.stdout.write(JSON.stringify({
    case: "measure", measured: name, n, agreement: agree / n, share_confident: confident / n,
    confident_agreement: confident ? confidentAgree / confident : null,
  }) + "\n");
  process.exit(OK);
}

const c = CASES[cmd ?? ""] ?? usage(`unknown command ${cmd ?? "(none)"}; expected ${Object.keys(CASES).join("|")}|measure`);
const name = cmd!;
const state: Record<string, string> = {};
for (const [flag, a] of Object.entries(c.args)) {
  state[a.key] = a.file ? file(flag, a.file) : need(flag);
}
const a = await ask(name, c, state);
const gated = a.verdict !== null && (c.gated === true || (c.gated?.includes(a.verdict) ?? false));
const shadow = gated && !automated(name);
const decision = shadow ? null : a.verdict;
const shown = typeof a.answer === "number" ? `p(${c.q.type === "noul" ? c.q.yes[0] : "yes"})=${pct(a.answer)}`
  : `${a.answer}${a.raw && a.raw !== a.answer ? ` (${a.raw})` : ""} p=${pct(a.confidence)}`;
const tag = c.tag ? ` ${args[c.tag]}` : "";
emit({
  case: name, source: "jev", model: a.model, answer: a.answer, raw: a.raw, confidence: a.confidence,
  verdict: a.verdict, decision,
  record: `jev ${name}${tag} ${shown} → ${a.verdict ?? "fallback: undecided"}${shadow ? " (shadow)" : ""}`,
}, decision ? OK : FALLBACK);
