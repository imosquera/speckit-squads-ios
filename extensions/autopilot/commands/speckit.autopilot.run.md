---
description: "Take the highest-priority eligible open GitHub issue (or a given issue number) from backlog to a reviewed draft PR by driving the full speckit pipeline unattended: pick → worktree → specify → clarify (auto-answered) → plan → tasks → implement → review → draft PR, gating on xcodebuild (iOS Simulator) or swift build/test, and posting a comment to the issue at every stage."
---

# Issue Backlog Autopilot

Take one GitHub issue from the backlog all the way to a reviewed **draft PR**, running
the full speckit pipeline unattended and narrating progress back to the issue so a
human can audit every decision after the fact.

The speckit commands already exist and each does its job well; the value here is the
**orchestration** — picking the right issue, wiring the worktree to the *existing*
issue (not a duplicate), auto-answering clarify instead of blocking on it, driving
every stage in order, recovering from gate failures, and leaving a clean draft PR.
You are the coordinator, not the implementer: prefer invoking the sibling
`/speckit-*` commands over re-deriving their work by hand.

## User Input

```text
$ARGUMENTS
```

Optional. If the input contains an issue number (e.g. `#42` or `42`), extract it as
`N` and work **that** issue instead of auto-picking by rank — but still apply the
eligibility checks in Step 1 (via `preflight-issues.ts`) and refuse (explaining why)
if it's already in progress, parked, or already claimed by another autopilot run.
With no input, auto-pick per Step 1 and set `N` to whichever issue the script picks.
This is also how the wrapper (`autopilot-run.ts`) hands off: it runs its own
preflight to decide whether to launch at all, then passes the picked issue number as
`$ARGUMENTS` so this run binds to the exact same issue instead of re-picking
independently.

## Operating contract

- **One issue per run.** Pick a single issue, take it to a draft PR, stop. Don't
  batch the backlog in one invocation — each issue is its own worktree, branch, and
  PR, and a human should be able to review them independently.
- **Full autonomy, full audit trail.** Answer clarify questions yourself and fix
  gate/test failures without asking — but write down *what* you decided and *why* as
  issue comments, so nothing is a black box. The right to act autonomously is paid
  for with a legible record.
- **Ceremony is proportional to the change.** A small, unambiguous fix skips
  spec/clarify/plan/tasks and goes straight to implementation — see
  [Step 2.5](#step-25--is-this-small-enough-to-skip-the-ceremony). Review, commit,
  and the draft PR are never skipped; they are the gates the fast path leans on.
- **Stop only on a hard blocker** (see [Stop conditions](#stop-conditions)). A
  wrong-but-recoverable guess is acceptable; a wrong *irreversible* action is not.
- **Optional lifecycle hooks run by default — `optional` is not `skip`.** Every
  registered `before_*` / `after_*` hook is part of the pipeline a human-driven run
  would get; `optional: true` in a manifest means "may be declined", not "skip when
  unattended". After each phase's mandatory work, **run the enabled hooks for that
  phase's slot** (auto-commit, issue sync, knowledge-graph and agent-context
  refreshes). Answer any confirmation `prompt:` with **yes**. Skip only when the
  hook's tool is genuinely missing/unauthed or it plainly doesn't apply to this
  project — and when you skip, **say which hook and why**, in the phase's issue
  comment, the same audit-trail discipline as an auto-answered clarify. Invoke a
  hook the way an interactive run would — **its registered command as a slash
  command** (`speckit.foo.bar` → `/speckit-foo-bar`), never reimplementing its work
  by hand and never through a `specify` CLI verb, because there is no hook-dispatch
  verb to reach for. Nothing runs these for you: the core command body *suggests*
  optional hooks and only *directs* mandatory ones, so an optional hook you don't
  invoke simply never happened (issue #45).
- **Tracking pipeline stages with the harness task tools?** `TaskCreate` /
  `TaskUpdate` / `TaskList` are **deferred** — their schemas aren't loaded, so
  calling one cold fails with `InputValidationError` (typed params get sent as
  strings). Before the first call, load them once:
  `ToolSearch` with query `select:TaskCreate,TaskUpdate,TaskList,TaskGet`. And
  `TaskCreate` creates **exactly one** task per call — pass `subject` and
  `description` as top-level strings; there is no `tasks`/`todos` array parameter,
  so loop and call once per stage rather than batching. Prefer prose progress /
  issue comments over a task list if in doubt — the pipeline order here is already
  fixed (Steps 1–9), so a todo list is optional scaffolding, not required.

## Preflight (fail fast, before touching anything)

Confirm the environment can complete the whole run — a pipeline that dies at the PR
step after writing code is worse than one that never starts.

1. **Speckit repo?** `.specify/` exists at the repo root. If not, this isn't a
   speckit project — stop and say so.
2. **`gh` authed?** `gh auth status` succeeds. The pick, the issue comments, and the
   PR all need it.
3. **Clean base.** You're on the repo's default branch (or a clean tree) so the new
   worktree forks from a sane point. Note (don't auto-discard) uncommitted junk.
4. **Resolve the repo** with `gh repo view --json nameWithOwner` — every `gh` call
   below is scoped to it explicitly, never relying on ambient state.
5. **Scheduled? Suggest it up front** (advisory, non-blocking). Check whether a
   recurring autopilot timer is installed for this repo, and if not, surface the tip
   **right now — before doing any work** — so the user can opt in for future passes.
   On macOS:
   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   SCHED="$PROJECT_DIR/.specify/extensions/autopilot/scripts/ts/autopilot-schedule.ts"
   [ -f "$SCHED" ] && bun "$SCHED" status --project "$PROJECT_DIR" | head -1
   ```
   If the first line is `NOT SCHEDULED`, say once, then continue with this run:

   > Tip: this repo isn't on an autopilot schedule. Run `/speckit-autopilot-schedule`
   > to have me work the backlog automatically every 2h (configurable, e.g.
   > `/speckit-autopilot-schedule install --interval-hours 4`). Opt-in and easy to
   > stop with `/speckit-autopilot-schedule uninstall`. I'll proceed with this run now.

   If it's already `SCHEDULED`, say nothing. Never schedule it yourself — scheduling
   is always a deliberate user action. (If the script is absent or this isn't macOS,
   skip silently.) The suggestion is a one-time nudge at the start; don't repeat it
   later in the run.
6. **iOS toolchain and a simulator.** Every gate in Steps 7–8 builds and tests the
   app, and an unattended run has nobody to open Xcode, so resolve the build system
   and a Simulator destination now, once, and reuse them for the whole run:
   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   GUARD="$PROJECT_DIR/.specify/extensions/autopilot/scripts/ts/check-target-repo.ts"
   SIM="$PROJECT_DIR/.specify/extensions/autopilot/scripts/ts/sim-destination.ts"
   bun "$GUARD" --repo-root "$PROJECT_DIR" --kind
   # => "KIND: workspace App.xcworkspace" | "KIND: project App.xcodeproj"
   #    | "KIND: package Package.swift"   | "KIND: none" (exit 1)
   xcodebuild -version && DEST="$(bun "$SIM")" && echo "$DEST"
   # => "platform=iOS Simulator,id=<udid>"   (device + runtime on stderr)
   ```
   - `workspace` / `project` → needs `xcodebuild` (full Xcode, not just the Command
     Line Tools) **and** a destination. For the scheme, take the one the project
     documents (constitution, `CLAUDE.md`, a `Makefile`/fastlane lane); otherwise run
     `xcodebuild -list -json -workspace …` (or `-project …`) and pick the app scheme
     named after the project, never a test-only or Pods scheme. Record the scheme,
     `KIND` and destination in the Step 3 comment so every later gate is reproducible.
   - `package` (a pure Swift package) → `swift build` / `swift test` need no
     simulator, unless the package only builds for iOS (`platforms: [.iOS…]` and
     UIKit imports), in which case treat it like a project: `xcodebuild -scheme
     <package> -destination "$DEST"` works on a package directory too.
   - `KIND: none` — check for a generator (`project.yml` → `xcodegen generate`,
     `Project.swift` → `tuist generate`) and re-run `--kind` after generating;
     if there is still nothing to build, this isn't an iOS project. Stop and say so.
   - `sim-destination.ts` exits 1 when no iOS runtime is installed (or `simctl` is
     missing because only the Command Line Tools are selected) — a **Missing
     capability** stop: installing a runtime is interactive. Nothing is picked or
     claimed yet, so there is nothing to park; stop and name what is missing. Set
     `SPECKIT_AUTOPILOT_SIM_DESTINATION` (any `-destination` string) to pin a
     device instead of the auto-pick (booted iPhone, else an iPhone on the newest
     iOS runtime).

## Step 1 — Pick the highest-ranked eligible issue (or validate the given one)

"Eligible" = open, not already in progress, not parked, not already claimed by
another autopilot run. Among the eligible, the pick is the **highest-ranked**, not
the oldest: `preflight-issues.ts` orders candidates by **priority label** (`p0` <
`p1` < `p2` < `p3`, with an unlabelled issue treated as `p2`), then **bugs before
features** within a tier, then oldest `createdAt` as the final tiebreak. A backlog
with no triage labels therefore behaves exactly as it used to — oldest-first —
while a labelled one drains in the order a human actually asked for. `/speckit-git-issue`
is what applies those labels; the picker only reads them.

Compute it deterministically via the script, then show your pick before proceeding.
The `PICK:` line carries the winning rank in brackets (e.g. `[p0, bug]`) — quote it
when you report the pick, so the log says why this issue beat the others.

**Fetch to a file, via the shared script — never pipe `gh` into a stdin-heredoc
script.** The tempting one-liner
`gh issue list --json … | bun - <<'EOF' … await Bun.stdin.json() … EOF` (or the
same shape with any interpreter that reads its program from `-`) **always fails**
with a JSON parse error on an empty input. The interpreter reads its *program* from
stdin, and the heredoc binds stdin to the heredoc text — that redirect wins over
the pipe, so `gh`'s JSON never reaches the script, which then reads an empty
stream. You cannot route both the script *and* the data through one stdin. `fetch-open-issues.ts` sidesteps this by
landing the data in a file first (sorted oldest-first — the ranking above reorders
it, and this sort is what makes age the stable final tiebreak — with `labels` and
`body` included for the ranking and the empty-body check), so every reader — this skill or `preflight-issues.ts`
directly — takes a **file path**, never stdin:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
FETCH_SCRIPT="$PROJECT_DIR/.specify/extensions/autopilot/scripts/ts/fetch-open-issues.ts"
bun "$FETCH_SCRIPT" /tmp/autopilot_issues.json
```

**Run the shared eligibility script for BOTH paths — never restate the rules
inline.** `preflight-issues.ts` is the single source of truth for what counts as
eligible (block labels — including `autopilot:claimed` — empty body, and an
existing branch/worktree/PR). An inline reimplementation of this list has drifted
from the script before (the explicit-issue path once omitted `autopilot:claimed`,
which is exactly how two runs collided on the same issue — see issue #19). Always
`exec` the script instead:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
PREFLIGHT_SCRIPT="$PROJECT_DIR/.specify/extensions/autopilot/scripts/ts/preflight-issues.ts"

# With an explicit issue number in $ARGUMENTS, validate THAT issue only:
bun "$PREFLIGHT_SCRIPT" /tmp/autopilot_issues.json "$N" --cross-repo
# => "PICK: #42 \"Fix the thing\" (explicit)"  or  "SKIP: #42 <reason>"

# With no input, auto-pick the highest-ranked eligible issue:
bun "$PREFLIGHT_SCRIPT" /tmp/autopilot_issues.json --cross-repo
# => "PICK: #42 \"Fix the thing\" [p0, bug] (7 open — 2 parked, 1 in-progress)"  or  "SKIP: ..."
```

**Always pass `--cross-repo`.** The rest of the eligibility check only sees *this*
repo, so an issue whose fix already shipped as a PR **somewhere else** looks
perfectly fresh. That is not hypothetical: on 2026-08-20 one issue was picked and
claimed by three separate runs after the first had already delivered it in another
repo — one of them starting 35 seconds after the delivering run finished (issue
#34). `--cross-repo` scans the issue's own thread for PR links, resolves them with
`gh pr view --repo`, and turns that into `SKIP: #N delivered — <url> (<state>)`.

A `SKIP:` result on the explicit-issue path means **stop immediately** — do not
create a spec, branch, worktree, or commit. Report the exact SKIP reason to the
user (e.g. "already claimed by another autopilot run" or "already in progress on
branch 082-…") before ending the session. `SKIP: #N blocked — <reason>` is the
durable case: a previous run hit a hard blocker and parked the issue (see
[Stop conditions](#stop-conditions)). The script reads that reason back out of the
issue thread, so **relay it verbatim** — a human who deliberately typed
`/speckit-autopilot-run N` is asking "why not?", and the answer is right there.
Do not clear `autopilot:blocked` to force a retry; clearing it is a human's call
once the underlying blocker is actually fixed. A `SKIP:` result on the auto-pick path
means the whole backlog is unworkable right now — say so and stop; that's success,
not failure, unless the script reported a hard failure (couldn't parse issues),
which is a Stop condition.

`STALE: #N <branch> — <evidence>` is the one verdict that is **not** a refusal. It
appears only on the explicit-issue path in an attended session, and it means: a
branch or worktree for `#N` exists, but the evidence says nothing is working on it
(clean tree, last commit older than the live window, no open PR). The two lines
after it are the choice, verbatim from the script:

```
STALE: #237 237-contacts — commit abc1234, clean, last commit 3d ago, 4/12 tasks done, no open PR
RESUME: 237 237-contacts /path/to/worktree
CLEAN: 237 git worktree remove /path/to/worktree && git branch -D 237-contacts
```

Relay all three to the operator and **ask which** — resuming someone's abandoned
half-finished worktree and deleting it are both irreversible-ish, and the operator
is the one who knows whether that spec was theirs. Never pick for them. Before
issue #60 this same situation printed `SKIP: #237 in-progress:237-contacts` and
nothing else, so an operator who had *just* created that worktree in the previous
session was refused with nothing to act on, seven times in fifty days. Under
`autopilot-run.ts` the verdict never appears — the wrapper exports
`SPECKIT_AUTOPILOT_UNATTENDED=1` and the hard `SKIP:` stands, because there is
nobody to answer and a live sibling run must never be reaped.

`SKIP: #N delivered — <url> (<state>)` needs one extra write before you stop.
Preflight only *reads*; without a durable mark the next tick re-derives the same
answer and the issue keeps cycling — the exact re-pick loop `autopilot:blocked`
was introduced to end (issue #32). Park it with the delivering PR as the reason,
then stop:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
PARK_SCRIPT="$PROJECT_DIR/.specify/extensions/autopilot/scripts/ts/park-issue.ts"
bun "$PARK_SCRIPT" "$N" \
  "delivered by <PR-URL> (<state>) — close this issue, or clear the autopilot:blocked label if that PR does not resolve it" \
  --title "✅ **Already delivered**"
```

Do **not** close the issue yourself: a linked PR is strong evidence, not proof, and
whether it truly resolves the issue is a human's call. Parking stops the waste;
closing is theirs.

`autopilot-run.ts` parks deliveries it finds in its own launch preflight, using the
same script — it exits before this skill ever starts, so it cannot delegate the
write here (and a delivered issue does not stop preflight's scan, so it can also
surface one while still picking a different issue). Parking is idempotent: an issue
that already carries `autopilot:blocked` is left alone rather than re-commented.

`gh issue list` already excludes PRs, so you won't accidentally grab one.

**Report the pick** to the user in one line (number, title, why it was chosen over
older ones that were skipped) before you start building.

## Step 1.5 — Confirm the fix belongs in THIS repo

**An autopilot run is bound to exactly one repository and one checkout.**
`autopilot-schedule.ts` writes the repo root into the launchd plist (one plist per
checkout, labelled `com.speckit.autopilot.<repo-slug>`), and `fetch-open-issues.ts`
reads issues only from that repo's own `gh issue list`. The work must land there
too — this run may not open a PR against a different repository.

Nothing used to check that. lead-drop#182 asked for a change to a file that resolved
into a *different* repo; autopilot did the work and opened the PR over there, while
the issue it "finished" stayed open. That is what then let three later runs pick the
same issue up again (issue #34). The pre-existing "fix target outside any git repo"
stop condition did not catch it, because that target was inside a perfectly good
repo — just not ours.

**This runs before the claim, not after it.** It used to sit after Step 1's claim
block, so a run that discovered the target was undeliverable had already written
`autopilot:claimed` onto an issue in a shared backlog and had to unwind it — the
recovery was correct but the claim should never have existed (issue #48). The guard
is read-only and takes a second; the claim is a write other runs can see, so the
cheap deterministic check goes first.

Putting a read-only step ahead of the claim does widen the unclaimed window, and
`gh issue edit --add-label` is not a compare-and-swap, so two runs that pass Step 1
together could both reach the claim (PR #98 review). The window is closed where it
can actually be closed — **after** the write, not by ordering: the claim block below
compares the issue's `labeled` timeline event before and against after its own edit,
and a run whose edit produced no new event is looking at somebody else's claim and
yields. That check works at any ordering, which is why the ordering can stay the one
that never claims an undeliverable issue. Underneath it, `autopilot-run.ts`'s
single-flight lock still serializes this machine's ticks and Step 2.0's liveness
re-check still catches a sibling that got as far as a branch or worktree.

So, before the claim — and before any spec, branch, or worktree: read the issue and
list every file path it asks you to change or create, then hand them all to the
guard in one call:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
GUARD="$PROJECT_DIR/.specify/extensions/autopilot/scripts/ts/check-target-repo.ts"
bun "$GUARD" App/Features/Login/LoginView.swift ~/some/other/Package.swift
# => "INSIDE: … → <repo>"   per target, then "KIND: …" (the repo's iOS target), then
#    "OK: 2 target(s) inside <repo>"          (exit 0 — proceed)
#    "BLOCKED: 1 of 2 target(s) not in <repo>" (exit 1 — stop, see below)
```

It resolves `~` and symlinks, and for a file that does not exist yet it uses the
deepest existing ancestor — the directory the file would be created in. Repo
identity is the git **common dir**, not the worktree toplevel, so a path inside this
feature's worktree correctly reads as INSIDE rather than foreign.

Pass paths you are reasonably confident about. If the issue names no file at all,
skip the guard rather than inventing targets — the check is a scope guard, not a
substitute for reading the issue.

**On a non-zero exit, stop.** This is a *Durable* stop: park the issue, exactly as
[Stop conditions](#stop-conditions) prescribes. There is no claim to release yet —
that is the point of running the guard here.

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
PARK_SCRIPT="$PROJECT_DIR/.specify/extensions/autopilot/scripts/ts/park-issue.ts"
bun "$PARK_SCRIPT" "$N" \
  "fix target <path> lives in <other-repo>; this autopilot run is bound to <this-repo> — move the issue to that repo, or clear autopilot:blocked if it can be fixed here" \
  --title "📍 **Wrong repository**"
```

Say plainly in the final report which repo the fix belongs in, so a human can move
the issue rather than guess why it was parked.

### Claim it — right after the locality guard, before anything else

The moment the guard above says the fix belongs here, claim the issue — **before**
doing anything else (before Step 2's worktree work, before writing any file). The
locality guard is the only thing that precedes the claim, and it precedes it because
it is read-only, deterministic, and can rule the issue out entirely (issue #48);
everything else waits, and the read-after-write check below is what keeps that
ordering safe rather than merely cheap. This is the one and
only place that applies the `autopilot:claimed` label — the wrapper script
(`autopilot-run.ts`) no longer claims on your behalf; it only decides whether to
launch you and which issue to hand you. That split matters: if the wrapper claimed
*and* the skill claimed, a session could see its own wrapper-applied claim during
its eligibility check and mistake it for a competing run (the "self-starve" bug).
Because claiming now happens exactly once, per run, inside the skill, that
confusion can't happen — you always know the claim on your picked issue is yours.

**Verify the claim is yours** — adding a label that is already there is a silent
no-op, so a successful `gh issue edit` proves nothing on its own. GitHub records a
`labeled` timeline event only when the label was actually *added*, so read the
newest one before and after your edit: if it did not change, your add was the no-op
and the standing claim belongs to another run.

```bash
claim_event() {   # newest `labeled autopilot:claimed` event, "" when unreadable
  gh api "repos/{owner}/{repo}/issues/$N/timeline" --paginate \
    --jq '[.[] | select(.event=="labeled" and .label.name=="autopilot:claimed")
           | .created_at] | last // empty' 2>/dev/null | tail -1
}
gh label create "autopilot:claimed" --color "0075ca" \
  --description "Autopilot is actively working this issue" 2>/dev/null || true
BEFORE="$(claim_event)"
gh issue edit "$N" --add-label "autopilot:claimed" \
  || { echo "claim failed on #$N — stopping rather than risk a collision"; exit 1; }
AFTER="$(claim_event)"
if [ -n "$AFTER" ] && [ "$AFTER" = "$BEFORE" ]; then
  echo "#$N was already claimed by another run at $AFTER — yielding"
  exit 1
fi
```

Two rules make that check safe to act on. **When you yield, do not remove the
label** — it is the other run's claim, and the cleanup snippets below apply only to
a claim you won. And when both reads come back empty (the timeline call failed, no
network, a token without the scope), **proceed**: the verification is an added
layer, and losing it leaves you exactly where every run stood before it existed,
not somewhere worse.

Labeling still isn't a distributed lock, so treat the whole thing as
defense-in-depth: the local single-flight lock in `autopilot-run.ts` serializes
same-machine ticks, the label plus this read-after-write serializes
cross-machine/manual runs, and Step 2's fresh liveness re-check catches whatever
gets past both. Remember to
**remove this label on every exit path** — success (end of Step 9) or any Stop
condition (see [Stop conditions](#stop-conditions)):

```bash
gh issue edit "$N" --remove-label "autopilot:claimed" 2>/dev/null || true
```

## Step 2 — Bind a worktree to the EXISTING issue (avoid the duplicate-issue trap)

This is the sharpest edge. `/speckit-git-feature` is built to **create a new** stub
issue and number the branch to it. Here the issue already exists, so you must bypass
that and bind to issue `#N` instead — otherwise you get a duplicate issue and
mismatched numbering.

0. **Re-check for a competing branch/worktree/PR right before creating anything.**
   Step 1's check happened moments ago; re-run it once more to shrink the race
   window as close to zero as the claim label allows. Use `--worktree-check`, NOT
   a full re-run of Step 1's eligibility script against the issue list — by now
   you've already added `autopilot:claimed` to `#N` yourself, so re-running the
   label-aware check would see your own claim and incorrectly report a collision
   with yourself on every single run. `--worktree-check` only looks at
   branches/worktrees/PRs, never labels, so it can't trip on your own claim:
   ```bash
   bun "$PREFLIGHT_SCRIPT" --worktree-check "$N"
   ```
   **Only `CLEAR` means proceed.** Anything else — `LIVE:` or `STALE:` — is a
   collision: a branch, worktree, or PR for `#N` now exists that did not exist a
   moment ago, so a sibling run created it in the interim. Stop and report it, same
   as a Step 1 SKIP, and remove your own claim first (see the cleanup snippet
   above). There is no automatic resume path in this skill; an existing branch or
   worktree for `#N` is never something to pick back up here (that ambiguity — an
   empty just-created worktree mistaken for an abandoned one — is exactly how two
   runs collided on issue #150; see issue #19).

   The verdict now carries its evidence (`STALE: 237-contacts — commit abc1234,
   clean, last commit 3d ago, no open PR`), and issue #60 is why: quote it in the
   report so the human deciding whether to clean the leftover up has the facts
   without re-deriving them. `STALE` here still does **not** license you to reap it
   — a thing that appeared in the seconds since Step 1 is far more likely to be a
   sibling that has not committed yet than genuine abandonment, and the classifier
   resolves every unknown toward `LIVE` precisely because reaping is the
   unrecoverable direction.
1. Derive a slug from the issue title (kebab-case, trimmed) and the branch name
   `NNN-slug`, zero-padded to the repo's convention (e.g. `082-signup-thankyou`).
2. Create the branch + worktree **without** creating an issue, and bind it to `#N`
   in the same call. `GIT_BRANCH_NAME` makes `/speckit-git-feature` skip issue
   creation (per its own contract); `--source-issue` tells it which existing issue
   to link, so it writes `.specify/feature.json` itself:
   ```bash
   GIT_BRANCH_NAME="NNN-slug" <run /speckit-git-feature --source-issue "$N">
   ```
   (Or use `/speckit-git-worktree` if a suitable branch already exists.)

   Confirm the linkage landed before moving on — one read, no repair:
   ```bash
   cat "<absolute path to the new worktree>/.specify/feature.json"   # source_issue must be N
   ```
3. **If that file is missing or names a different issue** — the installed `git`
   extension predates `--source-issue` (issue #44), or the worktree came from
   `/speckit-git-worktree` — bind it explicitly:
   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   BIND_SCRIPT="$PROJECT_DIR/.specify/extensions/autopilot/scripts/ts/bind-feature-issue.ts"
   bun "$BIND_SCRIPT" "$N" "<absolute path to the new worktree>"
   ```
   Do **not** write the file by hand. Both that script and `--source-issue` go
   through the git extension's shared writer, `spec_kit_write_feature_json()`,
   which does two things a raw `printf > .specify/feature.json` does not: it
   gitignores the file, and it `git rm --cached`s it in a project whose older
   layout still tracks it. Writing it raw leaves a *tracked* `feature.json`, which
   the next worktree cut from this branch then inherits — reviving the
   stale-inheritance bug of issue #33 on the one path that runs unattended
   (issue #21).

   `source_issue` is the only key you ever write or read here. The file also
   carries a `feature_directory` written once by `create-new-feature.ts` purely
   for core Spec Kit's own `get_feature_paths()` — leave it alone, and never
   resolve a path from it. Never add `branch_name`, `feature_num`, or
   `worktree_path`: every part of a feature's identity is derived from git at
   read time precisely so it cannot go stale, and recording paths in this file is
   what used to point `/speckit-git-clean` and `/speckit-git-pr` at the previous
   feature (issue #33).
4. **`cd` into the worktree** and run everything below from there. Speckit resolves
   paths from the worktree root; running from the main checkout drifts the cwd and
   breaks the `.specify/` scripts.
5. **Label the session.** Set a best-effort terminal-tab title for the running
   session so it's identifiable at a glance:
   ```bash
   printf '\033]0;autopilot #%s: %s\007' "$N" "<short issue title>"
   ```
   This sets the *terminal tab* only — Claude's own session title can't be renamed
   mid-run. Durable naming comes from the `session-title.ts` SessionStart hook
   (see the extension README): any session you open or **resume inside this
   worktree** is auto-titled `#N: <issue title>`.
6. **Post the first progress comment** on the issue: "🤖 Autopilot picked this up —
   worktree `NNN-slug` created. Starting spec."

## Step 2.5 — Is this small enough to skip the ceremony?

**A one-line fix does not need a spec, a plan, and a task list.** Producing four
documents for a three-line change is the ceremony costing more than the work, and
it buries the actual diff in a review. Decide once, here, before Step 3.

**Take the fast path only when every one of these holds** — read the code first;
this is a judgement about the change, not about the issue's word count:

- one behaviour changes, in roughly **1–3 files** and on the order of **50 lines**
- **nothing structural**: no new dependency (SPM package or framework), no
  schema/API/interface change, no SwiftData/Core Data model migration, no new
  entitlement, capability, `Info.plist` usage string or privacy-manifest entry, no
  new user-facing screen, no rename with a blast radius (a Swift rename also
  touches the `.pbxproj` when files move)
- **no real ambiguity** — after reading the code you know exactly what to change;
  there is nothing a `/speckit-clarify` round would have asked
- the issue is not labelled `epic`

Any doubt on any bullet → **full pipeline**, Steps 3–7 as written. The fast path is
for changes that are obviously small, not for changes you hope are small.

**Ask Jev for the call, after the hard rules.** An `epic` label is full pipeline
without asking. Otherwise, once you have read the code, write the issue body and
your planned change (files, rough line count, what changes) to files and run:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
gh issue view "$N" --json title,body --jq '"# " + .title + "\n\n" + .body' > /tmp/autopilot_issue_$N.md
# /tmp/autopilot_change_$N.md: your planned change, written before this call
bun "$PROJECT_DIR/.specify/extensions/autopilot/scripts/ts/jev.ts" fast-path \
  --issue /tmp/autopilot_issue_$N.md --change /tmp/autopilot_change_$N.md; echo "exit=$?"
```

Exit 0 → act on `decision`: `fast_path` or `full_pipeline`. Exit 3 → decide by the
bullets above exactly as without Jev. Either way keep the JSON's `record` for the
decision comment. Jev never overrides a hard rule: `epic` stays full pipeline, and
step 4's bail-out below still applies to a Jev-chosen fast path.

**On the fast path:**

1. **Skip Steps 3–6 entirely** — no `spec.md`, `plan.md`, `tasks.md`, no clarify.
   `create-pr.ts` falls back to the branch name when there is no spec, so nothing
   downstream breaks.
2. **Post the decision** as the issue comment for this phase: "🤖 Fast path — small
   change (<what changes, which files>); skipping spec/plan/tasks. Jev: `<record>`."
   That comment is the record a reviewer checks the call against. A full-pipeline
   call puts the same `Jev: <record>` line in Step 3's first progress comment.
3. **Implement directly** in the worktree, then rejoin at **Step 8 — Review**.
   Review, commit, and the draft PR are **not** optional on this path: they are the
   only gates left.
4. **Bail out to the full pipeline the moment the change stops being small.** If the
   edit spreads past the bullets above, say so in a comment, run `/speckit-specify`
   from where you are, and continue with Steps 3–7. Discovering the change was
   bigger than it looked is the expected failure mode, not a stop condition.

## Step 3 — Specify

Run `/speckit-specify` with the **issue body as the input** so the spec is grounded in
what was actually asked. Let it write `spec.md` and sync the issue. If the body is
thin, enrich the spec from the title + any linked context, but don't invent scope the
issue didn't imply.

Then run the `after_specify` hooks — all of them, per the Operating contract's
lifecycle-hook policy, not just the non-optional ones:

- **`speckit.git.issue`** (non-optional) — syncs the rendered spec back into the
  linked GitHub issue.
- **`speckit.git.commit`** (optional, prompts) — answer **yes**; the spec belongs on
  the branch before clarify starts editing it.
- **Knowledge-graph refresh** — only if this project keeps a graph (a
  `graphify-out/` directory in the worktree), refresh it with the Claude
  `/graphify` skill. `graphify` on `PATH` alone is not a reason. It is not a
  `specify` subcommand.
- **Agent-context refresh** (optional) — the core `agent-context` extension's
  `speckit.agent-context.update`, invoked as the slash command
  **`/speckit-agent-context-update`**, so Steps 5–8 plan against the new spec instead
  of stale context. If the project doesn't have that extension, look for an
  `update-agent-context` script under `.specify/scripts/bash/` instead.

**Nothing fires these on its own — `auto_execute_hooks` is not a runtime.** There is
no hook executor anywhere in the `specify` CLI; the dispatcher is the core
`/speckit-specify` command body, and it dispatches *by prose addressed to you*. For a
**mandatory** hook it emits an `EXECUTE_COMMAND:` block you are told to act on; for an
**optional** hook it emits only ``To execute: `/{command}` `` — a suggestion with no
directive behind it. `settings.auto_execute_hooks: true` does not change that. So the
two hooks that need you most — the graphify and agent-context refreshes, both
`optional: true` — are precisely the two that never run unless you run them (issue
#45: silent no-ops across five features in `imosquera/enroute`).

**Invoke them as slash commands, never as a CLI verb.** `specify` has no
hook-dispatch surface at all: no `hook`, no `hooks`, and `specify event run` is the
native-harness event bridge, not this. A line like `specify hook run
speckit.agent-context.update` is an invention, and its usage error (`No such command
'hook'`) is easy to pipe away and read as success. `ls .specify/extensions/*/commands/`
lists the real command ids; a hook whose command is `speckit.foo.bar` is run as
`/speckit-foo-bar`.

Then **verify each one landed**, and treat a non-zero exit as a failure rather than
noise: `git log -1` for the commit, the issue body for the sync, `graphify-out/`'s
mtime for the graph, the agent-context file's diff for the refresh. If one is missing,
run it; if it genuinely can't run, name which and why in the Step 3 progress comment.
A hook that reported nothing is a hook that did nothing.

## Step 4 — Clarify (you answer the questions)

Run `/speckit-clarify`. It will surface `[NEEDS CLARIFICATION]` questions. **You answer
them** — that's the whole point of autopilot — using, in order of preference:

1. **The issue + repo context** — the answer is often already implied by the issue,
   the existing code, the constitution, or prior decisions. Read before guessing.
2. **Best-practice research** — for genuinely open questions (auth model, retry
   semantics, rate limits, accessibility, legal like CAN-SPAM/GDPR, App Store Review
   Guidelines, App Tracking Transparency, privacy-manifest requirements, the Human
   Interface Guidelines), do a quick web search — Apple's developer documentation
   first — and pick the well-supported default. Cite the basis briefly.
3. **The conservative, reversible default** — when still unsure, choose the option
   that's easiest to change later and hardest to get catastrophically wrong.

**Record every answer as an issue comment** before applying it — a compact
"Clarifications (auto-answered)" list of `Q → A — because …`. This is the audit trail
that makes unattended clarify trustworthy. Then apply the answers to the spec exactly
as `/speckit-clarify` would (Clarifications session block + the affected FRs / edge
cases).

If a question is **irreducibly ambiguous AND a wrong guess is irreversible** (e.g.
"delete which production dataset?"), that's a hard blocker — see Stop conditions.

## Step 4.5 — `tooling` / `p3` skip plan and tasks

```bash
gh issue view "$N" --json labels --jq '[.labels[].name] | any(. == "tooling" or . == "p3")'
```

`true` → **skip Steps 5–7**: do not run `/speckit-plan`, `/speckit-tasks` or
`/speckit-implement` (implement's prerequisite check hard-requires `plan.md` and
`tasks.md`). Implement directly against `spec.md` in the worktree, then apply Step 7's
bullets (gates green, progress comment, `after_implement` hooks) and rejoin at Step 8.
Say "`tooling`/`p3`: skipping plan and tasks" in the progress comment.

`false` → Step 5 as written.

## Step 5 — Plan

Run `/speckit-plan`. It gates on the Constitution Check. To avoid the known
validate-loop, author the Constitution Check right the first time:

- **One quote per physical line** — the validator's quote regex can't match across a
  line-wrap, so a wrapped quote silently fails.
- **Never write a principle's key token in prose before its heading** — the section
  extractor grabs the first occurrence of the token, so "Principle IX" above the
  `### IX` heading hijacks the section → "NO VERDICT".
- **Bare verdict tokens** — `PASS` / `VIOLATES` / `N/A` with no trailing punctuation
  (`**VIOLATES.**` fails; `**VIOLATES**` passes).

Also honor whatever presets are enabled: check `.specify/presets/.registry`; if
`parse-dont-validate` is enabled, add the `## Parse Boundaries` section and run its
scanner rather than skipping it.

Run the `after_plan` hooks (the optional auto-commit — answer **yes**) per the
lifecycle-hook policy.

## Step 6 — Tasks

Run `/speckit-tasks` to generate the dependency-ordered `tasks.md`. No special
handling — just confirm it produced tasks covering the plan's MVP. Then run the
`after_tasks` hooks (auto-commit — answer **yes**).

## Step 7 — Implement

Run `/speckit-implement`. Then, because you're unattended:

- **Drive gates to green.** Build, tests, lint, the constitution audit, and any
  preset scanner must pass. When one fails, fix the code and re-run — that's expected
  autopilot work, not a blocker. Use the `KIND`, scheme and `$DEST` resolved in
  Preflight step 6 (re-run `sim-destination.ts` in this shell; each bash call is its
  own shell):
  ```bash
  # workspace (use -project App.xcodeproj for KIND: project)
  xcodebuild build -workspace App.xcworkspace -scheme App -destination "$DEST" -quiet
  xcodebuild test  -workspace App.xcworkspace -scheme App -destination "$DEST" -quiet
  # package
  swift build && swift test
  ```
  - A project command the repo documents (a `Makefile` target, a fastlane lane, a
    test plan via `-testPlan`) beats the generic line above — use what a human would.
  - Lint is whatever the repo configures: `swiftlint` when there is a
    `.swiftlint.yml`, `swift format lint` / `swiftformat --lint` when those configs
    exist. No config, no lint gate — don't invent one.
  - Add `-skipPackagePluginValidation -skipMacroValidation` only if the build fails
    asking you to trust a plugin/macro; never pass `-allowProvisioningUpdates` or
    touch signing — Simulator builds don't need a team, and a signing error means
    the scheme targets a device, not that you should add credentials.
  - Simulator flakiness (`Unable to boot device`, `FBSOpenApplicationServiceErrorDomain`,
    a test runner that hangs past launch) is environmental: `xcrun simctl shutdown
    all`, re-run once. The second failure is a gate failure like any other.
  - For a new local Swift package or a new target, it must be added to the Xcode
    project (or the workspace / parent `Package.swift`) before `xcodebuild` sees
    it — a file that compiles in isolation but isn't in any target is not done.
- **Post a progress comment** summarizing what shipped: files added/changed, test
  counts, and any task deliberately deferred (with why).
- **Run the `after_implement` hooks** — the auto-commit (answer **yes**), plus any
  preset-supplied refresh.
  `speckit.review.run` is also registered here; Step 8 is that hook, so running it
  there satisfies the slot — don't run the reviewers twice.

## Step 8 — Review

Run `/speckit-review-run` on the working diff (it fans out the specialized
reviewers — code, arch, tests, errors, comments, types, simplify — in parallel, and
applies ponytail's behaviour-preserving cuts itself). Triage the
findings: **apply** the clear correctness and test-coverage fixes; **record a
decision** ("keep — because …") for anything you deliberately leave, the same way a
human reviewer would. Re-run the gates after applying fixes.

## Step 9 — Open the draft PR

Run `/speckit-git-pr --draft` to push the branch and open the PR. `--draft` is the
whole handoff contract in one flag, so do **not** hand-roll it (issue #28):

- it passes `--draft` to `gh pr create` directly, so the PR is never briefly
  mergeable and never needs a post-hoc `gh pr ready <url> --undo`;
- it skips the `/speckit-archive-feature` pre-step, so the tracking issue stays
  **open** and the spec stays in the active tree until a human merges. Archiving
  there would close the issue and file the spec away before anyone reviewed the work.

Because `source_issue` is set, the body includes `Closes #N`, so merging later
auto-closes the issue.

**Final issue comment**: link the draft PR and give a 3–5 line summary — what was
built, the assumptions you made (link the earlier clarify comment), gate status
(tests/lint/audit green), and anything left for the human (a task deferred, a creds
step, a judgment call worth a second look).

**Remove the claim** now that a draft PR exists to show for it — the open PR itself
is a stronger in-progress signal than the label from here on:
```bash
gh issue edit "$N" --remove-label "autopilot:claimed" 2>/dev/null || true
```

Then report the same summary to the user, leading with the PR URL.

Waiting on CI? Use `gh pr checks <n> --watch --fail-fast` so the first failure
returns immediately instead of after every check finishes.

## Stop conditions (hard blockers only)

Stop, leave the worktree intact, post what you found to the issue, and hand back to
the user only when continuing would be reckless or is impossible:

- **Missing capability** — `gh` / build creds absent or unauthenticated, full Xcode
  not selected (`xcode-select -p` points at the Command Line Tools), no installed
  iOS Simulator runtime, or an Xcode license not yet accepted — and the step needs
  them (these are interactive; you can't do them). *Durable.*
- **Fix target outside any git repo** — the file the issue asks you to change
  resolves (often through a symlink) somewhere `git rev-parse` fails, so no PR
  against any repo could contain the fix. Resolve the real path with
  `readlink -f` / `realpath` before concluding this. *Durable.*
- **Fix target in a DIFFERENT git repo** — the target resolves inside a real
  repository that is not the one this run is bound to. Opening a PR there would put
  the work outside the repo whose backlog, schedule, and checkout this run owns, and
  would leave the issue open behind it (issue #34). `check-target-repo.ts` decides
  this; see [Step 1.5](#step-15--confirm-the-fix-belongs-in-this-repo). Park it and
  name the correct repo so a human can move the issue. *Durable.*
- **Not a speckit repo** — no `.specify/`. (Happens before any claim; nothing to
  clean up.)
- **Irreversible ambiguity** — a clarify or design decision that is both genuinely
  undetermined and destructive if guessed wrong (data deletion, spend, sending real
  messages, production migration). Ask; don't guess. *Durable.*
- **Repeated gate failure with no progress** — you've tried a fix two or three times
  and the same gate still fails for a reason you don't understand. Surface the exact
  error rather than thrash or paper over it. *Transient* — a flaky or environmental
  gate can pass on the next tick. But if the issue thread already carries a comment
  from an **earlier run** reporting the *same* gate failing the same way, that's not
  flakiness, it's a standing blocker: treat it as durable.

### Clean up on every stop — transient claim off, durable block on

Two distinct pieces of state, and getting only the first one right is what made
issue #32 re-pick a single issue in **10 consecutive sessions**.

**Always** remove the claim — a stuck claim on a dead run would block the issue
forever:
```bash
gh issue edit "$N" --remove-label "autopilot:claimed" 2>/dev/null || true
```

**Additionally, for a stop marked *Durable* above**, record the blocker where the
next run's preflight will actually see it. Removing the claim alone writes *no*
durable state, so `preflight-issues.ts` sees a clean, unlabeled, eligible issue on
the very next tick and picks it again — forever. `autopilot:blocked` is in that
script's `BLOCK` set, so this is the one write that ends the loop:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
PARK_SCRIPT="$PROJECT_DIR/.specify/extensions/autopilot/scripts/ts/park-issue.ts"
bun "$PARK_SCRIPT" "$N" "<ONE-LINE reason, self-contained, no leading formatting>"
```

`park-issue.ts` is the single writer of the label and the `AUTOPILOT-BLOCKED:`
sentinel — the unattended wrapper writes the same park through it — so the strings
the reader (`preflight-issues.ts`) greps for can never drift between two
hand-rolled copies. It creates the label if missing, posts the comment, applies the
label, and no-ops when the issue is already parked.

The `AUTOPILOT-BLOCKED:` marker is not decoration — `preflight-issues.ts`'s
`blocked_reason()` greps the issue's comments for that exact string (newest
match wins) and replays the text after it when a human explicitly re-runs
`/speckit-autopilot-run N`. So write **one** line there that stands alone out of
context ("fix target `~/Code/shared-kit/Sources/Networking/APIClient.swift` resolves outside
any git repo"), and put the narrative in the paragraph below it, not on the
marker line. Comment first, then label: if the label write lands and the comment
doesn't, the next run reports a blocker with no recorded reason.

Order matters on the way out too — add `autopilot:blocked` and remove
`autopilot:claimed`. Leaving the claim on would also block the issue, but it
would block it as a *stale lock* that a human is supposed to clear, which is the
opposite of the deliberate, documented park you just wrote.

**Never** apply `autopilot:blocked` for a transient stop — a collision with a
sibling run (Step 2's `LIVE:`), a flaky gate, a network blip. Those resolve on
their own; parking them permanently is worse than re-picking them.

A skipped or deferred *task* is not a blocker — note it and keep going. The bar for
stopping is "a human would be angry I proceeded," not "this got hard."

## Why it's built this way

- **Draft PR, not merge** — the human keeps the final gate; autopilot does the toil,
  not the irreversible call.
- **Issue comments at every stage** — unattended autonomy is only safe if it's
  auditable; the issue thread becomes the flight recorder.
- **Bind to the existing issue** — the single most common way this goes wrong is a
  duplicate issue + mismatched branch number from `/speckit-git-feature`'s
  create-path; forcing `GIT_BRANCH_NAME` and writing `source_issue` prevents it.
- **Answer clarify, don't skip it** — clarify catches the ambiguities that sink an
  implementation; auto-answering (with a logged rationale) keeps that value while
  removing the human wait.
- **Claiming lives in exactly one place** — the skill body, not the wrapper. Two
  autopilot runs collided on issue #150 partly because `autopilot-run.ts` claimed
  the label before launching `claude -p`, so that session's own preflight could see
  its own wrapper-applied claim and misread it as a competing run. Now the wrapper
  only picks and hands off an issue number; the skill claims once, per run, so a run
  always recognizes its own claim as its own.
- **One eligibility script, not two copies** — the explicit-issue path used to
  restate the block-label list inline and had already drifted from
  `preflight-issues.ts` (missing `autopilot:claimed`) by the time #150 collided.
  Both paths now `exec` the same script so they can't drift again.
- **A hard stop writes durable state, not just an unlock** — the cleanup path used
  to remove `autopilot:claimed` and nothing else. `autopilot:claimed` is a
  *transient* lock, so removing it restores the issue to the eligible pool in full;
  the next scheduled tick then re-picks the same issue, rediscovers the identical
  blocker, posts a near-duplicate comment, and unclaims — 10 times over two days on
  issue #181 before anyone noticed (issue #32). The audit-trail comments were the
  only record and nothing read them. `autopilot:blocked` is the counterpart write:
  durable, in the preflight script's own `BLOCK` set, and carrying its reason in a
  machine-readable comment marker so a deliberate re-run gets *told why* instead of
  silently repeating the cycle.
- **Never auto-resume a branch/worktree** — an empty, seconds-old worktree from a
  sibling run and a crashed leftover from days ago look identical at first glance.
  Proving "dead" (no open PR, no fresh pickup comment, no recent activity, no live
  `claude` process) is cheap; treating a live sibling as abandoned is not — it's
  exactly what happened on issue #150. When any signal is ambiguous, skip.
