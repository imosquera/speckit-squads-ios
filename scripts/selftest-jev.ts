#!/usr/bin/env bun
// selftest-jev.ts — every jev.ts case, driven through the real SDK against a
// fake Jev (TYPESAFE_BASE_URL), plus a check that every shipped copy of jev.ts
// is byte-identical to scripts/jev.ts.
//
// The fake answers from markers in the state it is sent: `PICK:<option>` picks
// a Choice option at 0.93, `P:<n>` answers a Noul with p(yes)=n, `SPLIT` spreads
// a Choice across the options a fold sums, `FORCE_400` fails the request.
//
// Usage: bun scripts/selftest-jev.ts

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const JEV = join(import.meta.dir, "jev.ts");
const WORK = mkdtempSync(join(tmpdir(), "selftest-jev-"));
let failures = 0;
type Json = Record<string, any>;

function report(ok: boolean, name: string, detail: string) {
  if (ok) console.log(`PASS: ${name}`);
  else { console.log(`FAIL: ${name} — ${detail}`); failures++; }
}

let lastRequest: { auth: string | null; body: Json } | null = null;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as Json;
    const auth = req.headers.get("authorization");
    lastRequest = { auth, body };
    if (auth !== "Bearer test-key") return new Response("{}", { status: 401 });
    const text = JSON.stringify(body.state), q = body.questions.q;
    if (text.includes("FORCE_400")) return new Response('{"error":"bad"}', { status: 400 });
    let answer: Json;
    if (q.type === "noul") {
      answer = { type: "noul", noul: Number(/P:([\d.]+)/.exec(text)?.[1] ?? 0.5) };
    } else {
      const keys = Object.keys(q.criteria);
      const split = text.includes("SPLIT"), pick = /PICK:(\w+)/.exec(text)?.[1] ?? "none_of_these";
      const probs = Object.fromEntries(keys.map((k, i) => [k, split ? (i === 1 ? 0.45 : i === 2 ? 0.45 : 0.1 / (keys.length - 2))
        : k === pick ? 0.93 : 0.07 / (keys.length - 1)]));
      answer = { type: "choice", choice: split ? keys[1] : pick, confidence: split ? 0.45 : 0.93, probabilities: probs };
    }
    return Response.json({ model: "jev-fake", answers: { q: answer }, usage: { input_tokens: 1, output_tokens: 1 } });
  },
});

// HOME and XDG_CONFIG_HOME point at an empty dir: the real key file never leaks in.
const HOME = join(WORK, "home");
const env = (extra: Record<string, string> = {}) => ({
  ...process.env, HOME, XDG_CONFIG_HOME: join(HOME, ".config"), TYPESAFE_BASE_URL: server.url.origin, TYPESAFE_API_KEY: "test-key",
  SPECKIT_JEV: "", SPECKIT_JEV_AUTOMATE: "", TDD_JEV_AUTOMATE_RED: "", ...extra,
});

async function run(args: string[], extra: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", JEV, ...args], { cwd: WORK, env: env(extra), stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
}

let n = 0;
const f = (body: string) => { const p = join(WORK, `f${n++}`); writeFileSync(p, body); return p; };

async function jev(name: string, want: number, wantDecision: string | null | undefined,
                   args: string[], extra: Record<string, string> = {}, wantVerdict?: string | null) {
  const r = await run(args, extra);
  let o: Json = {};
  try { o = JSON.parse(r.out); } catch { o = {}; }
  const ok = r.code === want && o.decision === wantDecision && !r.out.includes("test-key")
    && (wantVerdict === undefined || o.verdict === wantVerdict) && (want === 2 || typeof o.record === "string");
  report(ok, name, `want rc=${want} decision=${wantDecision}, got rc=${r.code}\n    ${r.out.trim()}`);
}

const choice = (c: string, opt: string, ...args: string[]) => [c, ...args.flatMap((a, i) => i % 2 ? [f(`PICK:${opt} ${a}`)] : [a])];
const yn = (c: string, p: number, ...args: string[]) => [c, ...args.flatMap((a, i) => i % 2 ? [f(`P:${p} ${a}`)] : [a])];
const red = (marker: string) => ["red-reason", "--scenario", "adds", "--test", f("t"), "--output", f(marker)];

// red-reason: gated (shadow) until automated, fold sums missing_* into expected_red
await jev("red automated", 0, "expected_red", red("PICK:expected_red"), { TDD_JEV_AUTOMATE_RED: "1" });
await jev("red automate list", 0, "harness_error", red("PICK:harness_error"), { SPECKIT_JEV_AUTOMATE: "tdd,red-reason" });
await jev("red fold", 0, "expected_red", red("SPLIT"), { SPECKIT_JEV_AUTOMATE: "all" });
await jev("red shadow", 3, null, red("PICK:expected_red"), {}, "expected_red");
await jev("red none_of_these", 3, null, red("PICK:none_of_these"), { SPECKIT_JEV_AUTOMATE: "all" }, null);

// Noul cases: yes, no, undecided
const NOULS: [string, string[], string, string, boolean?][] = [
  ["baseline", ["--failure", "x", "--baseline", "x"], "regression", "baseline_failure"],
  ["covers", ["--scenario", "x", "--test", "x"], "covered", "flag", true],
  ["exempt", ["--path", "x", "--diff", "x"], "exempt", "refused", true],
  ["duplicate", ["--new", "x", "--candidate", "x"], "duplicate", "distinct"],
  ["same-finding", ["--a", "x", "--b", "x"], "same", "distinct"],
  ["spec-change", ["--diff", "x"], "requirement", "wording"],
  ["applies-ui", ["--spec", "x"], "applies", "skip"],
  ["applies-library", ["--plan", "x"], "applies", "skip"],
];
for (const [c, args, yes, no, always] of NOULS) {
  // Only file args carry the marker: scalar args (--scenario, --path) stay plain.
  const build = (p: number) => [c, ...args.flatMap((a, i) => i % 2 === 0 ? [a]
    : ["--scenario", "--path"].includes(args[i - 1]!) ? [`P:${p}`] : [f(`P:${p}`)])];
  const gatedYes = c === "duplicate";
  await jev(`${c} yes`, gatedYes ? 3 : 0, gatedYes ? null : yes, build(0.95), {}, yes);
  await jev(`${c} no`, 0, no, build(0.05));
  await jev(`${c} undecided`, always ? 0 : 3, always ? no : null, build(0.5));
}
await jev("duplicate automated", 0, "duplicate", yn("duplicate", 0.95, "--new", "x", "--candidate", "x"), { SPECKIT_JEV_AUTOMATE: "duplicate" });

// Choice cases: every non-fold option decides, none_of_these falls back
const CHOICES: [string, string[], string[], Record<string, string>?][] = [
  ["priority", ["--issue", "x"], ["p0", "p1", "p3"]],
  ["kind", ["--issue", "x"], ["bug", "feature"]],
  ["layer", ["--spec", "x"], ["frontend", "backend", "full_stack", "no_layer"]],
  ["fast-path", ["--issue", "x", "--change", "x"], ["fast_path"]],
  ["finding", ["--finding", "x", "--code", "x"], ["defect", "style"]],
];
for (const [c, args, opts] of CHOICES) {
  for (const o of opts) await jev(`${c} ${o}`, 0, o, choice(c, o, ...args));
  await jev(`${c} none_of_these`, 3, null, choice(c, "none_of_these", ...args));
}
await jev("priority p2 fold", 0, "p2", choice("priority", "p2_feature", "--issue", "x"));
await jev("fast-path structural", 0, "full_pipeline", choice("fast-path", "structural", "--issue", "x", "--change", "x"));
await jev("finding false_positive shadow", 3, null, choice("finding", "false_positive", "--finding", "x", "--code", "x"), {}, "false_positive");
await jev("finding false_positive automated", 0, "false_positive",
  choice("finding", "false_positive", "--finding", "x", "--code", "x"), { SPECKIT_JEV_AUTOMATE: "finding" });

// fallback paths: the caller then behaves exactly as without Jev
await jev("off", 3, null, choice("kind", "bug", "--issue", "x"), { SPECKIT_JEV: "off" });
await jev("no key", 3, null, choice("kind", "bug", "--issue", "x"), { TYPESAFE_API_KEY: "" });
{
  // the key file stands in for the environment: ~/.config/typesafe/key, then ~/.typesafe_key
  mkdirSync(join(HOME, ".config", "typesafe"), { recursive: true });
  writeFileSync(join(HOME, ".typesafe_key"), "test-key\n");
  await jev("key from ~/.typesafe_key", 0, "bug", choice("kind", "bug", "--issue", "x"), { TYPESAFE_API_KEY: "" });
  writeFileSync(join(HOME, ".config", "typesafe", "key"), "wrong-key\n");
  await jev("~/.config/typesafe/key wins", 3, null, choice("kind", "bug", "--issue", "x"), { TYPESAFE_API_KEY: "" });
  rmSync(join(HOME, ".config"), { recursive: true }); rmSync(join(HOME, ".typesafe_key"));
}
await jev("api error", 3, null, ["kind", "--issue", f("FORCE_400")]);
await jev("bad usage", 2, undefined, ["kind"]);
await jev("unknown case", 2, undefined, ["nope"]);

// the request itself: key only in the header, none_of_these offered
lastRequest = null;
await run(choice("layer", "frontend", "--spec", "x"));
const req = lastRequest as { auth: string | null; body: Json } | null;
report(!!req && req.auth === "Bearer test-key" && "none_of_these" in req.body.questions.q.criteria
  && !JSON.stringify(req.body).includes("test-key"), "request shape", JSON.stringify(req));

// measure: agreement and confident share over past records
{
  const recs = [
    { scenario: "a", test: "t", output: "PICK:expected_red", label: "expected_red" },
    { scenario: "a", test: "t", output: "PICK:harness_error", label: "harness_error" },
    { scenario: "a", test: "t", output: "PICK:passes_immediately", label: "expected_red" },
  ];
  const r = await run(["measure", "--records", f(recs.map(x => JSON.stringify(x)).join("\n"))]);
  let m: Json = {};
  try { m = JSON.parse(r.out); } catch { /* reported below */ }
  report(m.n === 3 && Math.round(m.agreement * 3) === 2 && m.share_confident === 1, "measure red-reason", r.out.trim());
  const d = await run(["measure", "--case", "duplicate", "--records",
    f(JSON.stringify({ new: "P:0.95", candidate: "c", label: "duplicate" }) + "\n")]);
  try { m = JSON.parse(d.out); } catch { m = {}; }
  report(m.measured === "duplicate" && m.agreement === 1, "measure duplicate", d.out.trim());
}

// every shipped copy matches the canonical one
{
  const canon = readFileSync(JEV, "utf8");
  const copies = [...new Bun.Glob("{extensions,presets}/*/scripts/ts/jev.ts").scanSync(ROOT)];
  const drift = copies.filter(p => readFileSync(join(ROOT, p), "utf8") !== canon);
  report(copies.length > 0 && !drift.length, `copies in sync (${copies.length})`, `drifted: ${drift.join(", ")}`);
}

server.stop(true);
rmSync(WORK, { recursive: true, force: true });
console.log(failures ? `${failures} failure(s)` : "all passed");
process.exit(failures ? 1 : 0);
