#!/usr/bin/env bun
// git extension: find-duplicate-issues.ts
// Read-only scan for existing issues that may already cover the work about to
// be filed. It never edits, closes, comments on, or creates anything.
// Each distinctive title token is searched separately (GitHub ANDs terms in one
// query); a candidate scores one point per token hit plus one per token also in
// its title. Closed issues are included on purpose.
//
// Usage:
//   find-duplicate-issues.ts --title "<issue title>" [--keyword W]...
//                            [--exclude N]... [--state open|closed|all]
//                            [--limit N] [--min-score N] [--repo OWNER/REPO]
// Output (stdout, best first, callers parse it):
//   score<TAB>number<TAB>state<TAB>labels<TAB>updated<TAB>title<TAB>url
// Summary on stderr. No candidates = no rows, exit 0.
// Exit codes: 0 scan ran, 1 usage/`gh` error.

export {}; // module scope, not a global script

const FETCH = 40, MAX_TOKENS = 8;
let title = "", state = "all", limit = 8, minScore = 3, repo = "";
const keywords: string[] = [], exclude: string[] = [];

function die(msg: string): never {
  console.error(`[speckit-git-issue] error: ${msg}`);
  process.exit(1);
}

const USAGE = `usage: find-duplicate-issues.ts --title "<issue title>" [--keyword W]...
                        [--exclude N]... [--state open|closed|all]
                        [--limit N] [--min-score N] [--repo OWNER/REPO]`;

const argv = process.argv.slice(2);
const value = (i: number, flag: string) => {
  const v = argv[i + 1];
  if (!v) die(`${flag} needs a value`);
  return v;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? "";
  switch (a) {
    case "--title": title = value(i++, a); break;
    case "--keyword": keywords.push(value(i++, a)); break;
    case "--exclude": exclude.push((argv[++i] ?? "").replace(/^#/, "")); break;
    case "--state": state = value(i++, a); break;
    case "--limit": limit = Number(value(i++, a)); break;
    case "--min-score": minScore = Number(value(i++, a)); break;
    case "--repo": repo = value(i++, a); break;
    case "-h": case "--help": console.log(USAGE); process.exit(0);
    default:
      if (a.startsWith("-")) die(`unknown flag: ${a}`);
      if (title) die(`unexpected argument: ${a}`);
      title = a;
  }
}

if (!title) die('usage: find-duplicate-issues.ts --title "<issue title>" [--keyword W] [--exclude N] [--state all] [--limit N]');
if (!["open", "closed", "all"].includes(state)) die("--state must be one of: open closed all");
if (!Bun.which("gh")) die("gh not found — install it or run 'gh auth login'");

// Strip this repo's own title decorations: `NNN: ` and the split-issue layer prefixes.
const clean = title
  .replace(/^[0-9]+:\s*/, "")
  .replace(/^(frontend\(mock\)|frontend|backend|wire-up|integration):\s*/i, "");

const STOPWORDS = new Set(("about above added adding also always another because been before being between both cannot could does doing done during each else even every from have having here into itself just like made make making more most much must need needs only other over same should since some such than that their them then there these they this those through under until upon very what when where which while will with without would your").split(" "));

// Distinctive tokens only: >=4 chars, no stopwords, longest first (ties reverse
// alphabetical, as `sort -rn` left them), capped at MAX_TOKENS.
const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const tokens = [...new Set(
  lower([clean, ...keywords].join(" "))
    .split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOPWORDS.has(t)),
)].sort((a, b) => b.length - a.length || (a < b ? 1 : a > b ? -1 : 0)).slice(0, MAX_TOKENS);
const searched = tokens.join(" ");

if (!tokens.length) {
  console.error(`[speckit-git-issue] duplicate scan: no distinctive terms in "${title}" — nothing to search`);
  process.exit(0);
}

type Issue = { number: number; title: string; state: string; labels?: { name: string }[] | null; updatedAt: string; url: string };
const results: unknown[] = [];
let parseOk = true;
tokens.forEach((tok, i) => {
  const r = Bun.spawnSync(["gh", "issue", "list", ...(repo ? ["--repo", repo] : []),
    "--state", state, "--limit", String(FETCH), "--search", `${tok} in:title,body`,
    "--json", "number,title,state,labels,updatedAt,url"], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    if (i === 0) die(`gh issue list failed: ${r.stderr.toString().split("\n").slice(0, 3).join("\n").replace(/\n+$/, "")}`);
    results.push([]);
    return;
  }
  try { results.push(JSON.parse(r.stdout.toString())); } catch { parseOk = false; }
});

const excl = new Set(exclude.filter((e) => /^[0-9]+$/.test(e)).map(Number));
// jq @tsv escaping
const tsv = (v: unknown) => v == null ? "" : typeof v === "string"
  ? v.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r")
  : String(v);

let rows: string[] = [];
if (parseOk) {
  const groups = new Map<number, { issue: Issue; hits: number }>();
  for (const c of (results.flat() as Issue[]).filter((c) => !excl.has(c.number))) {
    const g = groups.get(c.number);
    if (g) g.hits++; else groups.set(c.number, { issue: c, hits: 1 });
  }
  rows = [...groups.values()]
    .sort((a, b) => a.issue.number - b.issue.number)
    .map(({ issue, hits }) => ({ issue, score: hits + tokens.filter((t) => lower(issue.title).includes(t)).length }))
    .filter((c) => c.score >= minScore)
    // stable ascending sort then reverse, as jq's sort_by | reverse
    .sort((a, b) => a.score - b.score || (a.issue.updatedAt < b.issue.updatedAt ? -1 : a.issue.updatedAt > b.issue.updatedAt ? 1 : 0))
    .reverse()
    .slice(0, limit)
    .map(({ issue: c, score }) => [score, c.number, lower(c.state),
      (c.labels ?? []).map((l) => l.name).join(","), c.updatedAt.split("T")[0], c.title, c.url].map(tsv).join("\t"));
}

if (!rows.length) {
  console.error(`[speckit-git-issue] duplicate scan: no similar issues (searched: ${searched})`);
  process.exit(0);
}

console.error(`[speckit-git-issue] duplicate scan: ${rows.length} candidate(s) for "${clean}"`);
console.error(`[speckit-git-issue]   searched: ${searched}`);
console.error("[speckit-git-issue]   score  number  state  labels  updated  title  url");
console.log(rows.join("\n"));
