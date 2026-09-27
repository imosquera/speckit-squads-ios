#!/usr/bin/env bun
/**
 * Evaluate the open-issue backlog and emit a single descriptive log line.
 *
 * Three modes, selected by argv:
 *   preflight-issues.ts <issues.json>              — auto-pick the highest-ranked eligible issue
 *   preflight-issues.ts <issues.json> <N>          — validate ONE specific issue number
 *   preflight-issues.ts --worktree-check <N>       — branch/worktree/PR existence + liveness
 *
 * `--cross-repo` may be added to either of the first two modes; `--unattended` /
 * `--attended` override the `SPECKIT_AUTOPILOT_UNATTENDED` environment variable
 * that decides whether a STALE worktree is offered back or refused.
 * `--selftest` runs the built-in checks.
 *
 * The first two modes share the same eligibility rules (block labels, empty
 * body, in-progress) so the auto-pick path and the explicit-issue path can
 * never drift apart — that drift (the explicit path skipping the
 * `autopilot:claimed` check) was one of the root causes of two autopilot runs
 * colliding on the same issue (repo issue #19).
 *
 * `--worktree-check` is deliberately narrower: it skips the label/body checks
 * entirely and only asks "does a branch, worktree, or PR already exist for
 * #N?" It exists for the skill's post-claim re-check (Step 2) — by that point
 * the run has already added `autopilot:claimed` to its OWN issue, so re-running
 * the full label-aware check would see that self-applied label and immediately
 * (and incorrectly) treat every run as colliding with itself.
 *
 * `autopilot:blocked` is the *durable* counterpart to the transient
 * `autopilot:claimed` lock. A run that hits a hard, non-recoverable blocker
 * removes its claim (transient) and adds `autopilot:blocked` (durable), so the
 * issue leaves the eligible pool for good instead of being re-picked on the very
 * next tick. Without it the cleanup path wrote no durable state at all and one
 * issue was re-picked in 10 consecutive sessions (repo issue #32). The reason
 * travels in an issue comment tagged with BLOCK_SENTINEL, which
 * `blocked_reason()` reads back so an explicit re-run is *told why* rather than
 * silently skipped.
 *
 * `--cross-repo` closes the blind spot that `in_progress` cannot see: a PR that
 * delivered the issue **in a different repository**. `has_open_pr()` searches only
 * the current repo, so when the fix for an issue ships elsewhere — a skills repo, a
 * sibling service — nothing here notices. On 2026-08-20 that cost three full
 * autopilot sessions on one issue: run 1 shipped the work as a PR in another repo,
 * and runs 2, 3 and 4 each got `PICK: ... (explicit)`, claimed the issue, and only
 * then discovered by hand that it was already done (repo issue #34). One of them
 * started 35 seconds after the delivering run finished.
 *
 * The scan reads the issue's own thread — body plus comments, the same fetch
 * `blocked_reason()` already pays for — pulls every `github.com/<owner>/<repo>/pull/<n>`
 * URL out of it, and resolves each with `gh pr view --repo`. A **merged** PR wins over
 * a merely open one; a **closed, unmerged** PR is ignored, since abandoned work must
 * not park an issue forever. Draft status is reported but does not change the verdict:
 * an open draft still means someone is on it, matching the "existence alone means skip"
 * rule below.
 *
 * It is opt-in because it costs one `gh issue view` plus one `gh pr view` per linked
 * PR, and on the auto-pick path it runs **only against the issue about to be picked**
 * — the one place the answer changes the outcome — never against every candidate.
 *
 * This script only ever *reads*. A confirmed cross-repo delivery still needs the
 * durable `autopilot:blocked` park, and that write belongs to the caller — via the
 * shared `park-issue.ts`, the single writer of the label and sentinel.
 *
 * To make that possible for *every* caller, a cross-repo finding is also emitted as
 * machine-readable `DELIVERED: <n> <url> (<state>)` lines after the verdict line.
 * Two callers need them and neither can recover the finding from the verdict prose:
 *
 *   * `autopilot-run.ts` exits on `SKIP:` **before** launching the skill, so when a
 *     delivered issue leaves nothing else eligible the skill — the only component
 *     that used to park — never runs at all. The finding would be rediscovered, with
 *     the same GitHub lookups, on every scheduled tick forever.
 *   * A delivered issue does not stop the scan (see `auto_pick`), so a run can report
 *     `PICK:` for a *later* issue while still having found a delivered earlier one.
 *     That one needs parking too, on the success path.
 *
 * The verdict is always the FIRST line, so the existing "read the first word to
 * decide" contract is unchanged; callers that do not care about parking can keep
 * reading `head -1` and ignore the rest.
 *
 * Existence of a branch/worktree/PR still stops every unattended path — nothing
 * is ever auto-resumed (issue #19 fix #3). What changed with issue #60 is that the
 * stop now carries **evidence** instead of a bare verdict. "A live sibling run and
 * an abandoned worktree look identical from the outside" was true of the output,
 * not of the worktree: `liveness()` reads the tip commit's age, whether the tree is
 * dirty, how far `tasks.md` got, and whether a PR is open, and `classify()` turns
 * those into LIVE or STALE. An operator who pasted an issue URL and got
 * `SKIP: #237 in-progress:237-…` had nothing to act on and had to judge staleness
 * by hand — in seven sessions over fifty days.
 *
 * The classification is deliberately asymmetric: **ambiguity resolves to LIVE.** A
 * tree whose state could not be read, a tip with no readable date, a checkout with
 * no readable creation stamp, and a `gh pr list` that errored all count as live.
 * Reaping a running sibling's worktree is unrecoverable; refusing a dead one costs
 * a human one command, which the STALE output now prints for them.
 *
 * **Age is the age of the work, not of the commit it started from.** A worktree
 * created seconds ago off a base commit from months back inherits that old date,
 * is clean, and has no PR yet — three quarters of a STALE verdict for a checkout
 * a sibling is still setting up (PR #98 review). `worktree_touched()` supplies the
 * missing signal from the checkout's own git dir mtime and the branch ref's newest
 * reflog entry, and `classify()` takes the **most recent** of the two ages, so only
 * a worktree that is both old and untouched is ever called stale.
 *
 * STALE downgrades the verdict on exactly one path: an **attended** explicit-issue
 * run, where a human typed the number and is owed resume-or-clean rather than a
 * refusal. The unattended paths — auto-pick, and the explicit path under
 * `SPECKIT_AUTOPILOT_UNATTENDED=1` (exported by `autopilot-run.ts`) — keep the hard
 * SKIP, because there guessing is genuinely unsafe and nobody is reading the
 * evidence anyway.
 *
 * Auto-pick orders the eligible pool by (priority, bug-before-feature, layer, age)
 * — see the "ordering" block below — instead of taking the oldest. The chosen
 * issue's rank is echoed in the PICK line so a scheduled log says *why* it won.
 *
 * Output format (callers read the first word to decide):
 *   PICK: #42 "Fix the thing" [p0, bug] — 7 open (2 parked, 1 in-progress)
 *   SKIP: backlog clear — 3 open, all parked/in-progress
 *   SKIP: no open issues
 *   SKIP: 5 open but all in-progress (branches: 003-foo, 005-bar)
 *   PICK: #42 "Fix the thing" (explicit)
 *   SKIP: #42 parked:autopilot:claimed
 *   SKIP: #42 blocked — fix target is outside any git repo
 *   SKIP: #42 in-progress:082-fix-thing (live — uncommitted changes, …)
 *   SKIP: #42 blocked-by:#40,#41
 *   SKIP: #42 delivered — https://github.com/o/r/pull/3 (merged)
 *   SKIP: #42 not open or not found
 *   STALE: #42 082-fix-thing — commit abc1234, clean, last commit 3d ago, no open PR
 *
 * Plus, after the verdict line, zero or more machine-readable follow-ups:
 *   DELIVERED: 42 https://github.com/o/r/pull/3 (merged)
 *   RESUME: 42 082-fix-thing /path/to/worktree
 *   CLEAN: 42 git worktree remove /path/to/worktree && git branch -D 082-fix-thing
 *
 * `--worktree-check` prints one of:
 *   CLEAR
 *   LIVE: 082-fix-thing — uncommitted changes, last commit 4m ago, no open PR
 *   LIVE: 082-fix-thing — commit abc1234, clean, last commit 40d ago, worktree
 *         touched just now, no open PR
 *   STALE: 082-fix-thing — commit abc1234, clean, last commit 3d ago, no open PR
 *
 * Ported from `preflight-issues.py`; the output is byte-for-byte the same. The
 * Python semantics this depends on (JSON key order, int vs float, whitespace,
 * `splitlines`, code-point slicing, `repr`) come from `./py.ts`. Function names
 * keep their Python spelling so the docs that cite them (`rank_key`,
 * `blocked_by()`, `blocked_reason()`) still resolve.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  PyError, type PyDict, type PyValue,
  asStr, cpSlice, pyDecodeUtf8, pyEq, pyGet, pyHashKey, pyInt, pyItem, pyIter, pyJsonDumps,
  pyJsonLoads, pyLen, pyLstrip, pyNum, pyOr, pySplit, pySplitlines, pyStr, pyStrip,
  pyTruthy, pyZfill, strRepr, WS, writeOut,
} from "./py.ts";

const S = `[${WS}]`; // Python's `\s`
const W = "[\\p{L}\\p{N}_]"; // Python's Unicode `\w`

const BLOCK = new Set([
  "blocked", "wontfix", "duplicate",
  "needs-discussion", "needs discussion",
  "on-hold", "on hold", "question", "epic",
  "autopilot:claimed",
  "autopilot:blocked",
]);

// Durable "do not retry" label, and the marker autopilot writes into the issue
// comment that explains why. Kept here so the writer (the skill) and the reader
// (this script) can never disagree about the string.
const BLOCKED_LABEL = "autopilot:blocked";
const BLOCK_SENTINEL = "AUTOPILOT-BLOCKED:";

// Cross-repo delivery detection. Only fully-qualified PR URLs count: the
// `owner/repo#N` shorthand is ambiguous (it renders identically for issues) and
// resolving it would spend a `gh` call per false positive.
const PR_URL_RE = /https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/g;

// ------------------------------------------------------------ dependencies ---
// `/speckit-git-issue` splits a full-stack feature into frontend(mock), backend,
// and wire-up children (`split-issue.ts`). The wire-up child cannot be started
// until both siblings land, and says so in its own body:
//
//     Blocked by: #43, #44
//
// Without this check autopilot would rank that child level with its siblings and
// could pick it first, "integrating" a frontend and a backend that do not exist
// yet. The dependency is resolved against the open-issue list this run already
// fetched — a dependency that is not in it is closed (or not in this repo) and
// therefore satisfied — so the test costs no `gh` calls at all.
//
// The parent of a split needs no rule here: `split-issue.ts` labels it `epic`,
// which is already in BLOCK.
const BLOCKED_BY_RE = new RegExp(`^[ \\t>*\\-]*blocked[ _\\-]?by${S}*:?${S}*(.*)$`, "iu");
const ISSUE_REF_RE = /#(\d+)/g;

// A wrapped dependency line is one line. Bodies are prose and every editor wraps
// prose, so `Blocked by: #43,\n#44` used to yield [43] and the wire-up child read
// as unblocked the moment #43 closed (issue #76) — the same defect class as #68,
// whose fix lives in the diff-minimal preset's own script tree and so cannot be
// imported here. A continuation is any non-blank line that does not itself open
// something; a blank line ends the marker. Folding one line too many can only
// over-block, which is the safe direction.
const CONTINUATION_STOP_RE = new RegExp(
  `^${S}*(?:#{1,6}${S}|[\\-*+]${S}|\\d+[.)]${S}|>|\\||\`\`\`|~~~` +
    `|\\*{2}[^*]+\\*{2}${S}*:|[A-Za-z](?:${W}|[ \\t\\-]){0,40}:(?:${S}|$))`,
  "u",
);

// A PR in these states means someone already delivered the issue. CLOSED is
// absent on purpose — a closed, unmerged PR is abandoned work, and treating it
// as delivery would park the issue permanently on a dead end.
const DELIVERED_STATES = ["MERGED", "OPEN"];

// Bound on how many linked PRs one issue thread is worth resolving. A chatty
// thread can accumulate many links; the delivering PR is effectively never the
// 11th one mentioned.
const MAX_PR_LOOKUPS = 10;

// ---------------------------------------------------------------- ordering ---
// The backlog arrives oldest-first (`fetch-open-issues.ts` sorts by createdAt),
// but "oldest" is not the same as "most important": a P0 outage filed this
// morning sat behind a year-old chore, every tick, until a human intervened.
// Eligible candidates are therefore ordered by (priority, kind, layer, age)
// instead of age alone. Age remains the final tiebreak, so the previous behaviour is what
// you get on a backlog with no priority or type labels at all.
//
// Priority is read from labels in any of the common spellings — `p0`, `P1`,
// `priority: p2`, `priority/p3`, `priority-p1` — plus the severity words teams
// use instead (`critical` → p0, `high` → p1, `medium` → p2, `low` → p3). The
// LOWEST rank found on an issue wins, so a mislabelled `p2, critical` pair is
// treated as p0 rather than silently averaged.
const PRIORITY_WORDS: Record<string, number> = {
  critical: 0, urgent: 0, high: 1, medium: 2, normal: 2, low: 3,
};
const PRIORITY_RE = /^(?:priority[:/ -]*)?p(\d)$/;

// An issue with NO priority label sorts in the middle, level with p2 — not last.
// Ranking it last would let an explicitly deprioritized `p3` chore outrank every
// untriaged bug in the backlog, which inverts the point of the label.
const DEFAULT_PRIORITY = 2;

// Within one priority tier, defects come before new work: a broken system is
// worth more than an addition to it. Across tiers priority still wins, so an
// explicit p0 feature outranks a p2 bug — the labels a human set are the
// strongest signal available.
const BUG_LABELS = new Set(["bug", "defect", "regression", "fix", "broken", "incident", "outage"]);
const BUG_TITLE_RE = new RegExp(`^${S}*(?:\\[[^\\]]*\\]${S}*)?(?:bug|fix|hotfix)\\b[:( ]`, "iu");

// Within one priority tier and one kind, the mock-first split's frontend child
// comes before its backend sibling: the mock freezes the data shape the backend
// then implements, so building the backend first hands the UI a contract it did
// not get to choose. This used to fall out of `split-issue.ts`'s creation order
// via the age tiebreak, which held only while both children kept equal priority,
// equal kind, and their original relative age — none of which is enforced
// (issue #56). The labels are the ones `label-issue.ts` writes (`LAYERS`).
// An issue with no layer label ranks in the middle, level with `backend`, so an
// unlabelled backlog sorts exactly as it did before.
const LAYER_RANKS: Record<string, number> = { frontend: 0, backend: 1, integration: 2 };
const DEFAULT_LAYER = 1;

type Issue = PyValue;
type Labels = Set<string>;

/** `{l["name"].lower() for l in i.get("labels", [])}` */
function labels_of(issue: Issue): Labels {
  const out = new Set<string>();
  for (const l of pyIter(pyGet(issue, "labels", []))) {
    out.add(asStr(pyItem(l, "name"), "lower").toLowerCase());
  }
  return out;
}

function body_of(issue: Issue): string {
  return asStr(pyOr(pyGet(issue, "body"), ""), "strip");
}

/** Every `Blocked by:` tail in `body`, with wrapped continuations folded in. */
function* _blocked_by_lines(body: string): Generator<string> {
  const lines = pySplitlines(body);
  for (let i = 0; i < lines.length; i++) {
    const m = BLOCKED_BY_RE.exec(lines[i] as string);
    if (!m) continue;
    const tail = [m[1] as string];
    for (const nxt of lines.slice(i + 1)) {
      if (!pyStrip(nxt) || CONTINUATION_STOP_RE.test(nxt)) break;
      tail.push(pyStrip(nxt));
    }
    yield tail.join(" ");
  }
}

/** Open issues #N must close before this one starts; [] when unblocked. */
function blocked_by(issue: Issue, open_numbers: Set<string>): number[] {
  const body = asStr(pyOr(pyGet(issue, "body"), ""), "splitlines");
  const deps: number[] = [];
  const self = pyGet(issue, "number");
  for (const line of _blocked_by_lines(body)) {
    for (const m of line.matchAll(ISSUE_REF_RE)) {
      const n = Number(m[1]);
      if (!pyEq(n, self) && open_numbers.has(pyHashKey(n)) && !deps.includes(n)) deps.push(n);
    }
  }
  return deps;
}

/** Every priority rank an issue's labels spell out, in no order. */
function priority_ranks(labels: Labels): number[] {
  const ranks: number[] = [];
  for (const name of labels) {
    const m = PRIORITY_RE.exec(pyStrip(name));
    if (m) ranks.push(Number(m[1]));
    else if (Object.hasOwn(PRIORITY_WORDS, name)) ranks.push(PRIORITY_WORDS[name] as number);
  }
  return ranks;
}

/** Lowest priority rank among an issue's labels; DEFAULT_PRIORITY if none. */
function priority_rank(labels: Labels): number {
  const ranks = priority_ranks(labels);
  return ranks.length ? Math.min(...ranks) : DEFAULT_PRIORITY;
}

/** True when a human actually set a priority, vs DEFAULT_PRIORITY standing in. */
function labelled_priority(labels: Labels): boolean {
  return priority_ranks(labels).length > 0;
}

/**
 * True when the issue is a defect rather than new work.
 *
 * Labels are authoritative; the title prefix (`fix: …`, `bug(x): …`) is a
 * fallback for repos that file bugs without ever applying a label — this one
 * included, where conventional-commit-style titles carry the type.
 */
function is_bug(issue: Issue, labels: Labels): boolean {
  for (const l of labels) if (BUG_LABELS.has(l) || l.includes("bug")) return true;
  const title = pyOr(pyGet(issue, "title"), "");
  if (typeof title !== "string") throw new PyError("TypeError", "expected string or bytes-like object");
  return BUG_TITLE_RE.test(title);
}

/** Every layer rank an issue's labels spell out, in no order. */
function layer_ranks(labels: Labels): number[] {
  return [...labels].filter((l) => Object.hasOwn(LAYER_RANKS, l)).map((l) => LAYER_RANKS[l] as number);
}

/** Lowest layer rank among an issue's labels; DEFAULT_LAYER if none. */
function layer_rank(labels: Labels): number {
  const ranks = layer_ranks(labels);
  return ranks.length ? Math.min(...ranks) : DEFAULT_LAYER;
}

type RankKey = [number, number, number, number];

/**
 * Sort key for candidates: priority, then bugs, then layer, then oldest.
 *
 * `seq` is the issue's index in the (oldest-first) fetch, which keeps the
 * sort stable and makes age the final tiebreak without re-parsing dates.
 */
function rank_key(issue: Issue, seq: number): RankKey {
  const labels = labels_of(issue);
  return [priority_rank(labels), is_bug(issue, labels) ? 0 : 1, layer_rank(labels), seq];
}

function cmpKey(a: RankKey, b: RankKey): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d) return d;
  }
  return 0;
}

/**
 * Short why-this-one tag for the PICK line: `p0, bug, frontend`, `p2 default`.
 *
 * Says explicitly when the priority was assumed rather than labelled, so a log
 * line never implies a triage decision nobody made.
 */
function rank_reason(issue: Issue): string {
  const labels = labels_of(issue);
  const p = priority_rank(labels);
  const bits = [labelled_priority(labels) ? `p${p}` : `p${p} default`];
  if (is_bug(issue, labels)) bits.push("bug");
  const layers = [...labels].filter((l) => Object.hasOwn(LAYER_RANKS, l))
    .sort((a, b) => (LAYER_RANKS[a] as number) - (LAYER_RANKS[b] as number));
  if (layers.length) bits.push(layers[0] as string);
  return bits.join(", ");
}

// ------------------------------------------------------------- subprocess ---

/** (returncode, stripped stdout); (1, "") when the command could not run. */
function run(args: string[]): [number, string] {
  try {
    const p = Bun.spawnSync(args, { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder("utf-8", { fatal: true }).decode(p.stdout);
    return [p.exitCode ?? 1, pyStrip(out)];
  } catch {
    return [1, ""];
  }
}

/**
 * The side-effecting seams, gathered in one object so `--selftest` can stand in
 * for them exactly where the Python selftest patched module globals. Every
 * internal call goes through `io`, never directly, or a stand-in would miss it.
 */
const io = {
  sh(...args: string[]): string {
    return run(args)[1];
  },
  /**
   * (returncode, stdout) — for the calls where "failed" and "empty" differ.
   *
   * `sh()` collapses the two, which is fine for "did this print a branch name"
   * but not for "is this tree dirty": an empty answer from a git that errored
   * would read as `clean`, and clean is half of the STALE verdict.
   */
  sh_rc(...args: string[]): [number, string] {
    return run(args);
  },
  worktrees,
  locate,
  has_open_pr,
  liveness,
};

// ---------------------------------------------------------------- liveness ---
// How recent a commit still counts as a live run. Two hours is generous on
// purpose: an autopilot pass that is deep in `/speckit-implement` can go a long
// while between commits, and the cost of calling a live run stale is a reaped
// worktree, while the cost of calling a stale one live is one manual cleanup.
function liveWindowMin(): number {
  const raw = pyStrip(process.env.SPECKIT_AUTOPILOT_LIVE_WINDOW_MIN || "120");
  return raw ? pyInt(raw) : 120;
}
let LIVE_WINDOW_SEC = 120 * 60;

/**
 * True when nobody is reading the output.
 *
 * `autopilot-run.ts` exports `SPECKIT_AUTOPILOT_UNATTENDED=1` before launching
 * the session, so the skill's explicit-issue preflight can tell a scheduled
 * tick apart from a human who typed the issue number. There is no other seam:
 * both paths arrive as the same `preflight-issues.ts <file> <N>` call.
 */
function unattended(): boolean {
  const v = pyStrip(process.env.SPECKIT_AUTOPILOT_UNATTENDED || "").toLowerCase();
  return !["", "0", "false", "no", "off"].includes(v);
}

// How many open PRs one `has_open_pr` search may return before a miss stops
// meaning anything. `gh pr list --limit` caps exactly, so a page that comes back
// full may have left the matching PR off the end.
const PR_SEARCH_CAP = 100;

// `has_open_pr`'s fourth answer: the search answered but came back full, so its
// "not found" proves nothing. It votes LIVE exactly as `null` does, because it
// is an unknown, but it is not a failed lookup, and reporting it as one sent the
// operator to debug `gh` auth when the cause was a hundred PRs sharing a token
// (#104). Every reader has to test for it before testing `open_pr` for truth.
const TRUNCATED = "truncated";
type PrAnswer = boolean | null | typeof TRUNCATED;

/**
 * true / false / null / TRUNCATED — null when the lookup could not answer.
 *
 * Mirrors `is_dirty`: `gh` failing on auth, network, or an API error is not
 * evidence that no PR exists, and handing that `false` to `classify()` as if
 * it were would let a worktree with an open PR be reported STALE and offered
 * for deletion — the one direction that is unrecoverable. Ambiguity votes LIVE
 * (PR #98 review), so the failure has to survive as its own state.
 *
 * GitHub's full-text search tokenizes a bare number, so searching `401` matched
 * every open PR whose prose mentions an HTTP **401** — unrelated PRs, none of
 * them referencing the issue — and issue 401 was refused forever with no tree
 * state a human could clean up (#102). HTTP statuses, ports, and years
 * all collide this way.
 *
 * The local `#N\b` regex is what decides. The `#` in the query buys nothing —
 * GitHub strips it during tokenization, so `#401` and `401` return the same
 * candidates — it is there to say what is being looked for, and the regex is
 * the whole of the fix. `\b` keeps `#401` off `#4010`.
 *
 * That removes false *positives*. Recall still rests entirely on the search:
 * a PR the search does not return is one the regex never sees, and the answer
 * would be `false` — the unrecoverable direction. So a result set that came
 * back at the `--limit` is reported as `TRUNCATED`, because a truncated page and
 * an empty one are indistinguishable from here. It votes LIVE like `null`; only
 * the words it produces differ.
 */
function has_open_pr(n: PyValue): PrAnswer {
  const [rc, out] = io.sh_rc("gh", "pr", "list", "--state", "open",
    "--search", `#${pyStr(n)} in:title,body`, "--limit", String(PR_SEARCH_CAP),
    "--json", "title,body");
  if (rc !== 0) return null;
  let prs: PyValue[];
  let hit = false;
  try {
    const parsed = out ? pyJsonLoads(out) : [];
    // `\b` in a Python `str` regex is a Unicode word boundary.
    const ref = new RegExp(`#${pyStr(n)}(?!${W})`, "u");
    // Not just a parse error: a payload that is valid JSON but not a list of
    // objects (`{"message": "rate limited"}`, `null`, `[1]`) is not an answer.
    // `main()` has no top-level handler and `autopilot-run.ts` discards stderr,
    // so an escape here does not answer one issue wrong — it collapses the whole
    // preflight to empty output.
    prs = pyIter(parsed);
    for (const p of prs) {
      const text = `${pyStr(pyOr(pyGet(p, "title"), ""))}\n${pyStr(pyOr(pyGet(p, "body"), ""))}`;
      if (ref.test(text)) {
        hit = true;
        break;
      }
    }
  } catch {
    return null;
  }
  if (hit) return true;
  return pyLen(prs) >= PR_SEARCH_CAP ? TRUNCATED : false;
}

/** [(path, branch)] from `git worktree list --porcelain`. */
function worktrees(): [string, string][] {
  const out = io.sh("git", "worktree", "list", "--porcelain");
  const res: [string, string][] = [];
  let path = "", branch = "";
  for (const line of [...pySplitlines(out), ""]) {
    if (line.startsWith("worktree ")) {
      path = pyStrip(line.slice("worktree ".length));
      branch = "";
    } else if (line.startsWith("branch ")) {
      branch = pyStrip(line.slice("branch ".length)).split("/").at(-1) as string;
    } else if (!pyStrip(line)) {
      if (path) res.push([path, branch]);
      path = "";
      branch = "";
    }
  }
  return res;
}

/**
 * (name, worktree path, git ref) for issue #N's work; ["","",""] if none.
 *
 * The branch scan stays authoritative for the NAME — it also sees a branch
 * that has no worktree at all — and the worktree list only supplies the PATH
 * the dirty-tree and tasks.md evidence is read from.
 *
 * `name` is the display form with any prefix stripped (`fix/60-x` → `60-x`),
 * which is what every existing caller prints. `ref` is the full branch as git
 * knows it, because `git log <name>` on a stripped name resolves nothing and a
 * missing commit date reads as ambiguity — which votes LIVE, so a stale
 * `feat/`-prefixed branch would never be reportable as stale.
 *
 * Names come from `--format=%(refname:short)`, never from the default output,
 * which is written for people and broke the parse three ways. It prefixes a
 * marker: `* ` here, and since git 2.23 `+ ` for a branch checked out in
 * **another worktree**, which is every feature branch when preflight runs from
 * the main checkout. Stripping only `* ` left `ref` as `+ 368-slug`, which
 * `git log` cannot resolve, so the age read as unknown and no worktree-backed
 * branch could ever be reported STALE (#102). `color.ui=always` wraps names in
 * escape codes. And `column.ui=always` packs several branches onto one line, so
 * the "first line" held two names and the parse could hand back another
 * issue's branch (#104). The format atom prints the bare short refname and
 * nothing else. `--no-column` is load-bearing rather than tidy: a column
 * setting still packs `--format` output. Nothing is stripped, so nothing can be
 * stripped wrong.
 *
 * The globs anchor the number to the start of the branch name, or of any
 * `/`-delimited segment of it. git matches `*` across `/`, so `*\/416-*`
 * reaches `origin/416-slug` and `origin/feature/fix/416-deep` alike. Matching
 * is against the *shortened* refname, which is what `%(refname:short)` prints
 * too: `origin/416-slug` rather than `remotes/origin/416-slug`, unless another
 * ref shares the name, when git qualifies it (`heads/416-slug`,
 * `remotes/origin/416-slug`). The globs still match a qualified name, and
 * `git log` resolves it to the branch rather than to a tag of the same name,
 * which the old bare parse did not. `--sort=refname` keeps local branches ahead
 * of remotes: without it a `branch.sort` setting such as `-committerdate` put
 * `origin/416-slug` first and had its tip read in place of the local branch's.
 * A bare `*416-*` also matched
 * `v2.416-x` and `foo-416-bar` — the same tokenizer-class bug `has_open_pr`
 * carried, and the other half of #102. The zero-padded glob is added back
 * because a branch for issue 82 is named `082-slug`, coverage the old leading
 * `*` gave away for free.
 */
function locate(n: PyValue): [string, string, string] {
  const num = pyStr(n), pad = pyZfill(num, 3);
  let name = "", ref = "";
  const branches = io.sh("git", "branch", "-a", "--list", "--no-column",
    "--sort=refname", "--format=%(refname:short)",
    `${num}-*`, `*/${num}-*`, `${pad}-*`, `*/${pad}-*`);
  if (branches) {
    ref = pyStrip(pySplitlines(branches)[0] as string);
    name = ref.split("/").at(-1) as string;
  }
  const wts = io.worktrees();
  if (name) {
    for (const [path, branch] of wts) if (branch === name) return [name, path, ref];
  }
  for (const [path, _branch] of wts) {
    if (path.includes(`/${num}-`) || path.includes(`/${pyZfill(num, 3)}-`)) {
      const base = name || (pyRstripSlash(path).split("/").at(-1) as string);
      return [base, path, ref || base];
    }
  }
  return [name, "", ref];
}

function pyRstripSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** (short sha, unix timestamp) of `ref`'s tip; ["", 0] when unreadable. */
function tip_commit(ref: string): [string, number] {
  const parts = pySplit(io.sh("git", "log", "-1", "--format=%h %ct", ref, "--"));
  if (parts.length === 2 && /^\d+$/.test(parts[1] as string)) return [parts[0] as string, Number(parts[1])];
  return ["", 0];
}

function isdir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * true / false / null — null when the answer could not be obtained.
 *
 * null is not false: an unreadable tree is ambiguous, and ambiguity is LIVE.
 */
function is_dirty(path: string): boolean | null {
  if (!path || !isdir(path)) return null;
  const [rc, out] = io.sh_rc("git", "-C", path, "status", "--porcelain");
  return rc !== 0 ? null : Boolean(out);
}

const TASK_DONE_RE = new RegExp(`^${S}*[\\-*]${S}*\\[[xX]\\]`, "gmu");
const TASK_OPEN_RE = new RegExp(`^${S}*[\\-*]${S}*\\[ \\]`, "gmu");

/** "4/12" from the feature's `tasks.md`, or "" when there is none. */
function task_progress(name: string, path: string): string {
  const root = path || ".";
  const specs = join(root, "specs");
  let entries: string[] = [];
  try {
    entries = readdirSync(specs).filter((e) => e.startsWith(name) && !e.startsWith("."));
  } catch {
    entries = [];
  }
  const cands = entries.map((e) => join(specs, e, "tasks.md")).filter((c) => existsSync(c)).sort();
  for (const cand of cands) {
    let text: string;
    try {
      text = new TextDecoder("utf-8").decode(readFileSync(cand));
    } catch {
      continue;
    }
    const done = (text.match(TASK_DONE_RE) || []).length;
    const total = done + (text.match(TASK_OPEN_RE) || []).length;
    if (total) return `${done}/${total}`;
  }
  return "";
}

/**
 * Unix ts of the newest signal that the *work* — not its base commit — moved.
 *
 * A worktree created seconds ago from a base commit that is months old
 * inherits that old commit date. With a clean tree and no PR yet, tip-commit
 * age alone therefore classifies a sibling's brand-new checkout as STALE and
 * the attended path offers it for deletion before the sibling makes its first
 * edit (PR #98 review). Two signals date the checkout itself:
 *
 *   * the worktree's own git dir — written at creation (`HEAD`, `index`,
 *     `logs/HEAD`) and rewritten by every checkout, commit, and index update;
 *   * the branch ref's reflog, whose newest entry is the branch's own
 *     creation when nothing has happened since.
 *
 * Returns 0 when neither can be read, which the caller turns into "unknown" —
 * and unknown votes LIVE, exactly as everything else ambiguous here does.
 */
function worktree_touched(path: string, ref: string): number {
  const stamps: number[] = [];
  if (path && isdir(path)) {
    const [rc, gitdir] = io.sh_rc("git", "-C", path, "rev-parse", "--absolute-git-dir");
    if (rc === 0 && gitdir && isdir(gitdir)) {
      for (const cand of [gitdir, ...["HEAD", "index", "logs/HEAD"].map((f) => join(gitdir, f))]) {
        try {
          stamps.push(Math.floor(statSync(cand).mtimeMs / 1000));
        } catch {
          // unreadable stamp: skip it
        }
      }
    }
  }
  if (ref) {
    const out = io.sh("git", "log", "-g", "-1", "--format=%ct", ref);
    if (/^\d+$/.test(out)) stamps.push(Number(out));
  }
  return stamps.length ? Math.max(...stamps) : 0;
}

function age_words(age_sec: number | null): string {
  if (age_sec === null) return "commit date unknown";
  if (age_sec < 90 * 60) return `last commit ${Math.floor(age_sec / 60)}m ago`;
  if (age_sec < 36 * 3600) return `last commit ${Math.floor(age_sec / 3600)}h ago`;
  return `last commit ${Math.floor(age_sec / 86400)}d ago`;
}

function touch_words(sec: number | null): string {
  if (sec === null) return "worktree age unknown";
  if (sec < 120) return "worktree touched just now";
  if (sec < 90 * 60) return `worktree touched ${Math.floor(sec / 60)}m ago`;
  if (sec < 36 * 3600) return `worktree touched ${Math.floor(sec / 3600)}h ago`;
  return `worktree touched ${Math.floor(sec / 86400)}d ago`;
}

/**
 * [state, evidence] for work that exists — "LIVE" or "STALE".
 *
 * Pure by construction so the rule is testable without a repo, and so the
 * evidence string and the verdict are built from the same inputs and can
 * never disagree. Every unknown votes LIVE (see the header), and that now
 * includes both of the signals a caller may fail to obtain: `open_pr=null`
 * (the `gh` lookup failed) and `touched_sec=null` (no creation/heartbeat stamp
 * for the checkout). `touched_sec` defaults to null on purpose: a caller that
 * does not measure it gets LIVE, never STALE.
 *
 * The two ages are read as "most recent evidence wins" — a months-old tip
 * commit under a checkout created a minute ago is a run that has not committed
 * yet, not an abandoned worktree.
 */
function classify(
  dirty: boolean | null, age_sec: number | null, open_pr: PrAnswer, tasks = "",
  window_sec: number | null = null, touched_sec: number | null = null,
): [string, string] {
  const window = window_sec === null ? LIVE_WINDOW_SEC : window_sec;
  let live = false;
  const bits: string[] = [];
  if (dirty === null) {
    bits.push("tree state unknown");
    live = true;
  } else if (dirty) {
    bits.push("uncommitted changes");
    live = true;
  } else {
    bits.push("clean");
  }
  bits.push(age_words(age_sec));
  // The touch stamp is only worth printing when it says something the commit
  // age does not: a checkout younger than its own tip commit, or no stamp at
  // all. A worktree touched when it was last committed to adds no evidence.
  if (touched_sec === null || age_sec === null || age_sec - touched_sec >= 60) {
    bits.push(touch_words(touched_sec));
  }
  if (age_sec === null || touched_sec === null) live = true;
  else if (Math.min(age_sec, touched_sec) < window) live = true;
  if (open_pr === null) {
    bits.push("PR lookup failed");
    live = true;
  } else if (open_pr === TRUNCATED) {
    // Truthy, so it has to be caught here or `else if (open_pr)` calls it a PR.
    bits.push(`PR search truncated at ${PR_SEARCH_CAP} results`);
    live = true;
  } else if (open_pr) {
    bits.push("open PR");
    live = true;
  } else {
    bits.push("no open PR");
  }
  if (tasks) bits.push(`${tasks} tasks done`);
  return [live ? "LIVE" : "STALE", bits.join(", ")];
}

type Liveness = [string, string, string];
const _LIVE_CACHE = new Map<string, Liveness>();

/**
 * [state, name, evidence] for issue #N; ["", "", ""] when nothing exists.
 *
 * Cached: `eligibility_reason()` and the explicit-issue verdict both need it
 * for the same issue in one run, and it costs several git calls plus a `gh`.
 */
function liveness(n: PyValue): Liveness {
  const key = pyHashKey(n);
  const hit = _LIVE_CACHE.get(key);
  if (hit) return hit;
  const [name, path, ref] = io.locate(n);
  const now = Math.floor(Date.now() / 1000);
  let result: Liveness;
  if (!name) {
    // A failed lookup (null) is not "no PR": with nothing else to go on it
    // is the only signal there is, so it counts as work-in-flight rather
    // than as a clear field.
    const pr = io.has_open_pr(n);
    if (pr === null) {
      result = ["LIVE", `#${pyStr(n)}`, "PR lookup failed, no branch or worktree"];
    } else if (pr === TRUNCATED) {
      result = ["LIVE", `#${pyStr(n)}`, `PR search truncated at ${PR_SEARCH_CAP} results, no branch or worktree`];
    } else if (pr) {
      result = ["LIVE", `PR referencing #${pyStr(n)}`, "open PR, no branch or worktree"];
    } else {
      result = ["", "", ""];
    }
  } else {
    const [sha, ts] = tip_commit(ref || name);
    const age = ts ? Math.max(0, now - ts) : null;
    const touched_ts = worktree_touched(path, ref || name);
    const touched = touched_ts ? Math.max(0, now - touched_ts) : null;
    const [state, ev] = classify(is_dirty(path), age, io.has_open_pr(n),
      task_progress(name, path), null, touched);
    const head = sha ? `commit ${sha}` : "no commit";
    result = [state, name, `${head}, ${ev}`];
  }
  _LIVE_CACHE.set(key, result);
  return result;
}

const _THREAD_CACHE = new Map<string, [PyValue, PyValue[]]>();

/**
 * Return [body, [comment bodies…]] for issue #N, fetched at most once.
 *
 * `blocked_reason()` and `delivered_by()` both need the same thread, and on
 * the explicit-issue path both can run for one issue. Caching keeps that to a
 * single `gh issue view` instead of two.
 */
function issue_thread(n: PyValue): [PyValue, PyValue[]] {
  const key = pyHashKey(n);
  let hit = _THREAD_CACHE.get(key);
  if (!hit) {
    const out = io.sh("gh", "issue", "view", pyStr(n), "--json", "body,comments");
    let data: PyValue;
    try {
      data = out ? pyJsonLoads(out) : new Map();
    } catch {
      data = new Map();
    }
    const body = pyOr(pyGet(data, "body"), "");
    const comments = pyIter(pyOr(pyGet(data, "comments"), [])).map((c) => pyOr(pyGet(c, "body"), ""));
    hit = [body, comments];
    _THREAD_CACHE.set(key, hit);
  }
  return hit;
}

/**
 * Read back WHY autopilot durably blocked issue #N.
 *
 * The stopping run posts a comment containing a BLOCK_SENTINEL line; the
 * newest such comment wins (a later run may have refined the diagnosis).
 * Returns "" when no tagged comment exists — e.g. a human applied the label
 * by hand — so callers must treat the reason as best-effort, never as proof
 * the label is real. Only the explicit-issue path pays for this extra `gh`
 * call; auto-pick just counts the issue as parked.
 */
function blocked_reason(n: PyValue): string {
  const [, comments] = issue_thread(n);
  for (const body of [...comments].reverse()) {
    for (const line of pySplitlines(asStr(body, "splitlines"))) {
      const at = line.indexOf(BLOCK_SENTINEL);
      if (at >= 0) {
        return cpSlice(pyStrip(pyStrip(line.slice(at + BLOCK_SENTINEL.length)), "*_` "), 0, 160);
      }
    }
  }
  return "";
}

/**
 * Every distinct PR URL mentioned in issue #N's body or comments.
 *
 * Order is preserved (body first, then comments oldest→newest) and duplicates
 * are dropped, so a PR linked once by autopilot and again by a human costs one
 * lookup, not two.
 */
function linked_prs(n: PyValue): [string, string, string][] {
  const [body, comments] = issue_thread(n);
  const seen: [string, string, string][] = [];
  for (const text of [body, ...comments]) {
    if (typeof text !== "string") throw new PyError("TypeError", "expected string or bytes-like object");
    for (const m of text.matchAll(PR_URL_RE)) {
      const k: [string, string, string] = [m[1] as string, m[2] as string, m[3] as string];
      if (!seen.some((s) => s[0] === k[0] && s[1] === k[1] && s[2] === k[2])) seen.push(k);
    }
  }
  return seen.slice(0, MAX_PR_LOOKUPS);
}

/**
 * Return "<url> (<state>)" if a PR in ANY repo already delivered issue #N.
 *
 * Resolves every linked PR and prefers a MERGED one over a merely OPEN one, so
 * the message names the PR that actually shipped rather than whichever was
 * mentioned first. Returns "" when nothing is linked, nothing resolves (a
 * private repo the token cannot read, a deleted PR), or every linked PR is
 * closed-unmerged — all of which mean "no evidence of delivery", never
 * "definitely not delivered".
 */
function delivered_by(n: PyValue): string {
  let fallback = "";
  for (const [owner, repo, num] of linked_prs(n)) {
    const out = io.sh("gh", "pr", "view", num, "--repo", `${owner}/${repo}`, "--json", "state,isDraft,url");
    let pr: PyValue;
    try {
      pr = out ? pyJsonLoads(out) : new Map();
    } catch {
      continue;
    }
    const state = asStr(pyOr(pyGet(pr, "state"), ""), "upper").toUpperCase();
    if (!DELIVERED_STATES.includes(state)) continue;
    const url = pyStr(pyOr(pyGet(pr, "url"), `https://github.com/${owner}/${repo}/pull/${num}`));
    let detail = state.toLowerCase();
    if (pyTruthy(pyGet(pr, "isDraft"))) detail += ", draft";
    if (state === "MERGED") return `${url} (${detail})`;
    fallback = fallback || `${url} (${detail})`;
  }
  return fallback;
}

function blockingOf(labels: Labels): string[] {
  return [...labels].filter((l) => BLOCK.has(l)).sort();
}

/**
 * Return "" if eligible, else a SKIP reason string.
 *
 * `explain` costs one extra `gh` call and is only worth it on the
 * explicit-issue path, where a human typed the number and deserves to be
 * told why their re-run is refusing (repo issue #32).
 *
 * `cross_repo` is checked last because it is the most expensive test here —
 * every cheaper local signal gets a chance to skip the issue first.
 */
function eligibility_reason(i: Issue, explain = false, cross_repo = false,
  open_numbers: Set<string> = new Set()): string {
  const n = pyItem(i, "number");
  const blocking = blockingOf(labels_of(i));
  if (blocking.length) {
    if (explain && blocking.includes(BLOCKED_LABEL)) {
      const why = blocked_reason(n);
      return why ? `blocked — ${why}` : `blocked — ${BLOCKED_LABEL} label set, no recorded reason`;
    }
    return "parked:" + blocking.join(",");
  }
  if (!pyStrip(body_of(i))) return "empty-body";
  const deps = blocked_by(i, open_numbers);
  if (deps.length) return "blocked-by:" + deps.map((d) => `#${d}`).join(",");
  const [state, name, ev] = io.liveness(n);
  if (state) return `in-progress:${name} (${state.toLowerCase()} — ${ev})`;
  if (cross_repo) {
    const pr = delivered_by(n);
    if (pr) return `delivered — ${pr}`;
  }
  return "";
}

function openNumbers(issues: PyValue[]): Set<string> {
  return new Set(issues.map((i) => pyHashKey(pyGet(i, "number"))));
}

function titleOf(issue: Issue): string {
  return cpSlice(pyStrip(asStr(pyGet(issue, "title", ""), "strip")), 0, 70);
}

// Output sink: every verdict line goes through `out`, so the selftest can
// capture what a call printed — the lines ARE the contract.
let sink: (line: string) => void = (line) => writeOut(line + "\n");
function out(line: string): void {
  sink(line);
}

function validate_one(issues: PyValue, target: number, cross_repo = false, headless: boolean | null = null): void {
  const all = pyIter(issues);
  const match = all.find((i) => pyEq(pyGet(i, "number"), target));
  if (match === undefined) {
    out(`SKIP: #${target} not open or not found`);
    return;
  }
  const hl = headless === null ? unattended() : headless;
  const reason = eligibility_reason(match, true, cross_repo, openNumbers(all));
  if (reason) {
    // A human typed this number. If the only thing standing in the way is
    // work that the evidence says is dead, refusing with nothing to act on
    // is the dead end issue #60 reports — hand back the two commands that
    // resolve it instead. Unattended, the refusal stands: there is nobody
    // to choose, and reaping a sibling run's worktree is unrecoverable.
    const [state, name, ev] = io.liveness(target);
    if (state === "STALE" && !hl && reason.startsWith("in-progress:")) {
      const path = io.locate(target)[1];
      out(`STALE: #${target} ${name} — ${ev}`);
      out(`RESUME: ${target} ${name} ${path || "-"}`);
      let clean = `git branch -D ${name}`;
      if (path) clean = `git worktree remove ${path} && ${clean}`;
      out(`CLEAN: ${target} ${clean}`);
      return;
    }
    out(`SKIP: #${target} ${reason}`);
    if (reason.startsWith("delivered — ")) out(`DELIVERED: ${target} ${reason.slice("delivered — ".length)}`);
    return;
  }
  // No rank tag here: an explicitly requested issue is worked regardless of
  // where it would have sorted, and printing a rank would suggest otherwise.
  out(`PICK: #${target} "${titleOf(match)}" (explicit)`);
}

function auto_pick(issues: PyValue, cross_repo = false): void {
  const total = pyLen(issues);
  if (total === 0) {
    out("SKIP: no open issues");
    return;
  }
  const all = pyIter(issues);

  const parked: string[] = [];
  const in_prog: string[] = [];
  const empty_body: string[] = [];
  const blocked_deps: string[] = [];
  const delivered: [PyValue, string][] = [];
  const candidates: [RankKey, Issue][] = [];

  const open_numbers = openNumbers(all);

  all.forEach((i, seq) => {
    const n = pyItem(i, "number");
    const labels = labels_of(i);

    if (blockingOf(labels).length) {
      parked.push(`#${pyStr(n)}`);
      return;
    }

    if (!pyStrip(body_of(i))) {
      empty_body.push(`#${pyStr(n)}`);
      return;
    }

    const deps = blocked_by(i, open_numbers);
    if (deps.length) {
      blocked_deps.push(`#${pyStr(n)}(needs ${deps.map((d) => `#${d}`).join(", ")})`);
      return;
    }

    // Auto-pick keeps the hard skip for LIVE *and* STALE: nobody is reading
    // this log at the moment it is written, so resume-or-clean has no one to
    // offer itself to. The state is recorded so a human reading the log
    // afterwards can see which leftovers are worth cleaning up.
    const [state, name] = io.liveness(n);
    if (state) {
      in_prog.push(`#${pyStr(n)}(${name}: ${state.toLowerCase()})`);
      return;
    }

    candidates.push([rank_key(i, seq), i]);
  });

  // Order the whole eligible pool before choosing, rather than taking the
  // first one the (oldest-first) scan happens to reach. This is the only
  // place the ordering policy is applied — the explicit-issue path never
  // ranks, because a human who typed a number has already chosen.
  candidates.sort((a, b) => cmpKey(a[0], b[0]));

  let pick: Issue | undefined;
  for (const [, i] of candidates) {
    // Cross-repo delivery is tested only on the candidate about to be
    // picked, in rank order: it is the sole position where the answer
    // changes what this run does, and testing every candidate would spend
    // `gh` calls on issues we are not going to touch anyway. A delivered
    // one is recorded for parking and the next-ranked candidate is tried.
    if (cross_repo) {
      const pr = delivered_by(pyItem(i, "number"));
      if (pr) {
        delivered.push([pyItem(i, "number"), pr]);
        continue;
      }
    }
    pick = i;
    break;
  }

  const more = (xs: string[]): string => xs.slice(0, 3).join(", ") + (xs.length > 3 ? "…" : "");
  const parts: string[] = [];
  if (parked.length) parts.push(`${parked.length} parked`);
  if (empty_body.length) parts.push(`${empty_body.length} empty-body`);
  if (blocked_deps.length) parts.push(`${blocked_deps.length} blocked-by (${more(blocked_deps)})`);
  if (in_prog.length) parts.push(`${in_prog.length} in-progress (${more(in_prog)})`);
  if (delivered.length) {
    parts.push(`${delivered.length} delivered (${delivered.map(([n, pr]) => `#${pyStr(n)} ${pr}`).join(", ")})`);
  }
  const ctx = `${total} open` + (parts.length ? ` — ${parts.join(", ")}` : "");

  if (pick !== undefined) {
    out(`PICK: #${pyStr(pyItem(pick, "number"))} "${titleOf(pick)}" [${rank_reason(pick)}] (${ctx})`);
  } else {
    out(`SKIP: nothing eligible — ${ctx}`);
  }

  // After the verdict, never before it: the first line is the caller's contract.
  for (const [n, pr] of delivered) out(`DELIVERED: ${pyStr(n)} ${pr}`);
}

/** Python's wording for why `open(path)` / `json.load` failed. */
function describeLoadError(e: unknown, path: string): string {
  if (e instanceof PyError) return e.message;
  const code = (e as NodeJS.ErrnoException).code;
  const errno: Record<string, [number, string]> = {
    ENOENT: [2, "No such file or directory"],
    EACCES: [13, "Permission denied"],
    EISDIR: [21, "Is a directory"],
    ENOTDIR: [20, "Not a directory"],
    ELOOP: [62, "Too many levels of symbolic links"],
    ENAMETOOLONG: [63, "File name too long"],
  };
  const hit = code ? errno[code] : undefined;
  if (hit) return `[Errno ${hit[0]}] ${hit[1]}: ${strRepr(path)}`;
  return e instanceof Error ? e.message : String(e);
}

function parseIssueNumber(arg: string): number | null {
  try {
    return pyInt(pyLstrip(arg, "#"));
  } catch {
    out(`SKIP: bad issue number ${strRepr(arg)}`);
    return null;
  }
}

function main(): void {
  // Pull flags out first so `--cross-repo` can sit in any position without
  // ever being mistaken for the issue-number positional.
  let argv = process.argv.slice(2);
  const cross_repo = argv.includes("--cross-repo");
  // Explicit flags beat the environment in both directions, so a caller that
  // knows which it is never has to unset a variable it did not set.
  const headless = argv.includes("--unattended") ? true : argv.includes("--attended") ? false : null;
  argv = argv.filter((a) => !["--cross-repo", "--unattended", "--attended"].includes(a));

  if (!argv.length) {
    out("SKIP: no issues file given");
    return;
  }

  if (argv[0] === "--selftest") {
    selftest();
    return;
  }

  if (argv[0] === "--worktree-check") {
    if (argv.length < 2) {
      out("SKIP: --worktree-check requires an issue number");
      return;
    }
    const n = parseIssueNumber(argv[1] as string);
    if (n === null) return;
    const [state, name, ev] = io.liveness(n);
    out(state ? `${state}: ${name} — ${ev}` : "CLEAR");
    return;
  }

  let issues: PyValue;
  const file = argv[0] as string;
  try {
    // Python's text-mode `open()` keeps a BOM (json then refuses it) and
    // translates CRLF/CR to LF before the parser sees a byte.
    const text = pyDecodeUtf8(readFileSync(file));
    issues = pyJsonLoads(text.replace(/\r\n?/g, "\n"));
  } catch (e) {
    out(`SKIP: could not parse issues (${describeLoadError(e, file)})`);
    return;
  }

  if (argv.length >= 2 && pyStrip(argv[1] as string)) {
    const target = parseIssueNumber(argv[1] as string);
    if (target === null) return;
    validate_one(issues, target, cross_repo, headless);
    return;
  }

  auto_pick(issues, cross_repo);
}

// ---------------------------------------------------------------- selftest ---

class AssertionError extends Error {}

function check(cond: boolean, detail?: unknown): void {
  if (!cond) throw new AssertionError(detail === undefined ? "assertion failed" : String(detail));
}

function eqList(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Run `fn` and return what it printed — the verdict lines ARE the contract. */
function _capture(fn: () => void): string {
  let buf = "";
  const old = sink;
  sink = (line) => {
    buf += line + "\n";
  };
  try {
    fn();
  } finally {
    sink = old;
  }
  return buf;
}

function dict(obj: Record<string, PyValue>): PyDict {
  return new Map(Object.entries(obj));
}

/** `fnmatch.fnmatchcase` for the `*`/`?` globs `locate()` passes. */
function fnmatchcase(name: string, pat: string): boolean {
  const re = pat.replace(/[.+^${}()|[\]\\*?]/g, (c) => (c === "*" ? ".*" : c === "?" ? "." : "\\" + c));
  return new RegExp(`^${re}$`, "s").test(name);
}

/** Dependency parsing, liveness, and ranking. `--selftest` runs it. */
function selftest(): void {
  const open_numbers = new Set([43, 44, 99].map((n) => pyHashKey(n)));

  const deps = (body: string, number = 50): number[] =>
    blocked_by(dict({ number, body }), open_numbers);

  check(eqList(deps("Blocked by: #43, #44"), [43, 44]));
  // issue #76: the wrapped form used to lose every ref after the first.
  check(eqList(deps("Blocked by: #43,\n#44"), [43, 44]));
  check(eqList(deps("Parent: #7\n\nBlocked by: #43,\n#44\n\nWire it up."), [43, 44]));
  // A blank line, a bullet, and a new `key:` each end the marker.
  check(eqList(deps("Blocked by: #43\n\n#44"), [43]));
  check(eqList(deps("Blocked by: #43\n- see #44"), [43]));
  check(eqList(deps("Blocked by: #43\nParent: #44"), [43]));
  // Closed (absent from open_numbers) and self-references stay out.
  check(eqList(deps("Blocked by: #43, #77"), [43]));
  check(eqList(deps("Blocked by: #43, #50"), [43]));
  check(eqList(deps("nothing here"), []));

  // issue #56: the layer term, between kind and age.
  const issue = (number: number, names: string[] = [], title = "add saved searches"): PyDict =>
    dict({ number, title, labels: names.map((n) => dict({ name: n })) });

  const order = (...issues: PyDict[]): number[] =>
    issues.map((i, seq) => [rank_key(i, seq), i] as [RankKey, PyDict])
      .sort((a, b) => cmpKey(a[0], b[0]))
      .map(([, i]) => pyNum(pyGet(i, "number")) as number);

  const fe = issue(1, ["frontend", "mock-first"]), be = issue(2, ["backend"]);
  // Frontend wins whatever the creation order was...
  check(eqList(order(be, fe), [1, 2]));
  // ...and however the age tiebreak would have fallen out.
  check(eqList(order(fe, be), [1, 2]));
  // But priority and kind still outrank it.
  check(eqList(order(fe, issue(2, ["backend", "p1"])), [2, 1]));
  check(eqList(order(fe, issue(2, ["backend", "bug"])), [2, 1]));
  // An unlabelled issue sits level with backend, so age decides as before.
  check(eqList(order(issue(1), issue(2, ["backend"])), [1, 2]));
  check(eqList(order(issue(1, ["backend"]), issue(2)), [1, 2]));
  check(eqList(order(issue(1, ["integration"]), issue(2)), [2, 1]));
  check(rank_reason(fe) === "p2 default, frontend");
  check(rank_reason(issue(3, ["p0", "bug", "backend"])) === "p0, bug, backend");
  check(rank_reason(issue(4)) === "p2 default");

  // issue #60: stale vs live is decided from evidence, and ambiguity is live.
  const DAY = 86400;
  const SAME = Symbol("same");

  const cls = (dirty: boolean | null, age: number | null, pr: PrAnswer, tasks = "",
    touched: number | null | typeof SAME = SAME): [string, string] =>
    // Most cases predate the touch signal and mean "the checkout is as old
    // as its commit"; `touched=null` is the distinct "could not measure".
    classify(dirty, age, pr, tasks, null, touched === SAME ? age : touched);

  check(cls(false, 3 * DAY, false)[0] === "STALE");
  check(cls(true, 3 * DAY, false)[0] === "LIVE"); // dirty tree
  check(cls(false, 60, false)[0] === "LIVE"); // committed a minute ago
  check(cls(false, 3 * DAY, true)[0] === "LIVE"); // open PR
  check(cls(null, 3 * DAY, false)[0] === "LIVE"); // tree unreadable
  check(cls(false, null, false)[0] === "LIVE"); // commit date unreadable
  check(cls(false, 3 * DAY, false, "4/12")[1].includes("4/12 tasks done"));
  check(cls(false, 3 * DAY, false)[1].includes("no open PR"));

  // PR #98 review, P1: a worktree created seconds ago off an old base commit
  // is clean, has no PR, and inherits the old commit date. Age alone called it
  // STALE and the attended path offered to delete a sibling's live checkout.
  check(cls(false, 90 * DAY, false, "", 30)[0] === "LIVE");
  check(cls(false, 90 * DAY, false, "", 30)[1].includes("worktree touched just now"));
  // An unmeasurable checkout age is an unknown, and unknowns vote LIVE.
  check(cls(false, 90 * DAY, false, "", null)[0] === "LIVE");
  check(cls(false, 90 * DAY, false, "", null)[1].includes("worktree age unknown"));
  // A genuinely abandoned worktree — old commit AND untouched since — is still
  // STALE, so the fix does not simply disable the classification.
  check(cls(false, 3 * DAY, false, "", 3 * DAY)[0] === "STALE");
  check(cls(false, 3 * DAY, false, "", 2 * DAY)[0] === "STALE");
  // A touch signal is never *only* read: a fresh commit under an old gitdir
  // mtime (impossible in practice, but the rule is "most recent wins") is live.
  check(cls(false, 60, false, "", 90 * DAY)[0] === "LIVE");

  // PR #98 review, P2: a failed `gh pr list` is not evidence of "no PR".
  const real = { ...io };
  const argv: string[][] = [];

  /** Stand in for `gh pr list`, capturing argv so the query is testable. */
  const prs = (...items: (string | Record<string, string>)[]) => {
    const payload = pyJsonDumps(items.map((p) => (typeof p === "string" ? dict({ body: p }) : dict(p))));
    return (...a: string[]): [number, string] => {
      argv.push(a);
      return [0, payload];
    };
  };

  try {
    io.sh_rc = () => [1, ""]; // gh could not answer
    check(has_open_pr(7) === null);
    io.sh_rc = () => [0, "[]"]; // answered: none open
    check(has_open_pr(7) === false);
    io.sh_rc = prs("Closes #7");
    check(has_open_pr(7) === true);
    io.sh_rc = () => [0, "not json"]; // answered nonsense
    check(has_open_pr(7) === null);
    // Valid JSON that is not a list of objects is not an answer either. Before
    // #102 nothing here refused it at all: the truthiness of the payload
    // answered true for `{"message":…}`, `5` and `[1]` and false for `null`,
    // the unsafe direction, with no error to see.
    for (const payload of ['{"message":"rate limited"}', "null", "5", "[1]", '["#7"]']) {
      io.sh_rc = () => [0, payload];
      check(has_open_pr(7) === null, payload);
    }

    // Issue #102: the regex decides, not GitHub's tokenizer. A PR whose prose
    // mentions the bare number is not a PR about issue #N — searching `401`
    // matched every open PR discussing the HTTP status, and refused #401
    // forever with no tree state a human could clear.
    io.sh_rc = prs("returns a 401 when unauthenticated", "retries on 401 then gives up");
    check(has_open_pr(401) === false);
    io.sh_rc = prs("returns 401 — see #401 for the gate");
    check(has_open_pr(401) === true);
    // `\b` keeps #401 off #4010; the title counts as well as the body; and a
    // payload with no `body` key at all exercises the `or ''` coalesce.
    io.sh_rc = prs("supersedes #4010");
    check(has_open_pr(401) === false);
    io.sh_rc = prs({ title: "Closes #401" });
    check(has_open_pr(401) === true);
    // The query itself is part of the fix, and a mock that ignores argv would
    // let a revert to the bare-number search pass green.
    check((argv.at(-1) as string[]).includes("#401 in:title,body"), argv.at(-1));
    check((argv.at(-1) as string[]).includes("--limit"), argv.at(-1));
    // A full page is a truncated page as far as this function can tell, and
    // "not found" here is the direction that gets a live worktree deleted.
    // TRUNCATED rather than null, so the operator is told why (#104).
    io.sh_rc = prs(...Array<string>(PR_SEARCH_CAP).fill("no reference here"));
    check(has_open_pr(401) === TRUNCATED);
    io.sh_rc = prs(...Array<string>(99).fill("no reference here"), "Closes #401");
    check(has_open_pr(401) === true);
  } finally {
    Object.assign(io, real);
  }

  // Issue #102's other half, and #104. `fake_sh` stands in for
  // `git branch -a --list` rather than for the glob list, so this exercises the
  // patterns AND the name parsing below them. Asserting on the argv alone is a
  // change detector that cannot tell a correct glob from a wrong one.
  //
  // What it reproduces, all confirmed against git 2.50.1: matching is against
  // the SHORTENED refname (`origin/x`, so a `remotes/` pattern selects
  // nothing); `*` crosses `/`, because git's `match_pattern` calls wildmatch
  // without `WM_PATHNAME`; and `--format=%(refname:short)` with `--no-column`
  // prints those short names, one per line, with no marker and no colour even
  // under `color.ui=always` and `column.ui=always`. Git qualifies a name
  // (`heads/x`) only when another ref shares it, and no fixture here does.
  // Sorting stands in for `--sort=refname`. Case-sensitive matching, because
  // git is case-sensitive by default.
  let REFS = ["416-picker-number-collision", "082-fix-thing",
    "origin/feature/fix/416-deep", "v2.416-x",
    "269-unreadable-416-cart", "4416-something"];
  try {
    io.worktrees = () => [];
    io.sh = (...a: string[]): string => {
      // The three flags are #104's fix, and this fake models none of what
      // they prevent, so this assertion is the only thing guarding them;
      // their effect was checked against real git, not here. Without
      // --format the output carries markers and colour, without --no-column
      // a column setting packs several names onto the one line this reads,
      // and without --sort=refname a `branch.sort` setting can put a
      // remote ahead of the local branch.
      check(eqList(a.slice(0, 7), ["git", "branch", "-a", "--list", "--no-column",
        "--sort=refname", "--format=%(refname:short)"]), a);
      return [...REFS].sort().filter((m) => a.slice(7).some((g) => fnmatchcase(m, g))).join("\n");
    };
    // Under --sort=refname the local branch sorts ahead of any remote and
    // wins, and `ref` is the bare name `git log` resolves.
    check(locate(416)[0] === "416-picker-number-collision", locate(416));
    check(locate(416)[2] === "416-picker-number-collision", locate(416));
    // `*` crosses `/`, so `*/416-*` still reaches a nested remote branch, and
    // its ref is the short `origin/...` form, which `git log` resolves.
    REFS = ["origin/feature/fix/416-deep"];
    check(locate(416)[0] === "416-deep", locate(416));
    check(locate(416)[2] === "origin/feature/fix/416-deep", locate(416));
    // All three of these matched the old `*416-*`; none is issue 416's work.
    REFS = ["v2.416-x", "269-unreadable-416-cart", "4416-something"];
    check(eqList(locate(416), ["", "", ""]), locate(416));
    // Each glob on its own, for an issue whose padded and unpadded forms
    // differ. For 416 the two are the same string, so only `{pad}-*` had a
    // case of its own (`082-fix-thing`) and deleting any of the other three
    // still passed (#104).
    for (const [only, found] of [
      ["82-x", "82-x"], // {num}-*
      ["origin/82-x", "82-x"], // */{num}-*
      ["082-fix-thing", "082-fix-thing"], // {pad}-*
      ["origin/082-x", "082-x"], // */{pad}-*
    ] as const) {
      REFS = [only];
      check(locate(82)[0] === found, [only, locate(82)]);
    }
  } finally {
    Object.assign(io, real);
  }
  check(cls(false, 3 * DAY, null, "", 3 * DAY)[0] === "LIVE");
  check(cls(false, 3 * DAY, null, "", 3 * DAY)[1].includes("PR lookup failed"));
  check(!cls(false, 3 * DAY, null, "", 3 * DAY)[1].includes("no open PR"));
  // TRUNCATED votes LIVE like null, but says what happened. It is truthy, so a
  // `classify` that forgot it would fall through and report an open PR (#104).
  check(cls(false, 3 * DAY, TRUNCATED, "", 3 * DAY)[0] === "LIVE");
  check(cls(false, 3 * DAY, TRUNCATED, "", 3 * DAY)[1].includes("truncated"));
  check(!cls(false, 3 * DAY, TRUNCATED, "", 3 * DAY)[1].includes("open PR"));
  // `liveness` reads `has_open_pr` itself when there is no branch or worktree,
  // without going through `classify`, so it needs its own check. Without one a
  // truncated search printed "open PR", the exact misreport TRUNCATED exists
  // to prevent.
  try {
    io.locate = () => ["", "", ""];
    io.has_open_pr = () => TRUNCATED;
    _LIVE_CACHE.delete(pyHashKey(9104));
    const [state, name, ev] = liveness(9104);
    check(state === "LIVE", [state, name, ev]);
    check(ev.includes("truncated") && !ev.includes("open PR"), ev);
  } finally {
    Object.assign(io, real);
    _LIVE_CACHE.delete(pyHashKey(9104));
  }

  // …and the verdict it produces on the explicit-issue path depends on who is
  // reading. This is the whole of issue #60: the operator pasted an issue URL
  // and got `SKIP: #237 in-progress:237-…` with nothing to act on.
  const issues = [dict({ number: 237, title: "uniqueness", body: "do the thing", labels: [] })];
  try {
    io.liveness = () => ["STALE", "237-contacts", "commit abc1234, clean, last commit 3d ago, no open PR"];
    io.locate = () => ["237-contacts", "/tmp/wt/237-contacts", "237-contacts"];

    const attended = _capture(() => validate_one(issues, 237, false, false));
    check(attended.startsWith("STALE: #237 237-contacts — commit abc1234"), attended);
    check(attended.includes("RESUME: 237 237-contacts /tmp/wt/237-contacts"), attended);
    check(attended.includes("CLEAN: 237 git worktree remove /tmp/wt/237-contacts"), attended);

    // Unattended, the hard SKIP stands — with the evidence attached.
    const headless = _capture(() => validate_one(issues, 237, false, true));
    check(headless.startsWith("SKIP: #237 in-progress:237-contacts (stale — "), headless);

    // A LIVE verdict never downgrades, attended or not.
    io.liveness = () => ["LIVE", "237-contacts", "uncommitted changes, last commit 4m ago, no open PR"];
    const live = _capture(() => validate_one(issues, 237, false, false));
    check(live.startsWith("SKIP: #237 in-progress:237-contacts (live — "), live);
  } finally {
    Object.assign(io, real);
  }

  out("OK: preflight-issues selftest");
}

try {
  // Read at start-up, as the Python module did at import: a malformed value
  // fails every mode, `--selftest` included, rather than only the ones that
  // happen to classify a worktree.
  LIVE_WINDOW_SEC = liveWindowMin() * 60;
  main();
} catch (e) {
  const name = e instanceof PyError ? e.pyName : e instanceof AssertionError ? "AssertionError" : "Error";
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`Traceback (most recent call last):\n${name}: ${msg}\n`);
  process.exit(1);
}
