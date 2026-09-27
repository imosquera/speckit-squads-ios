---
description: "Sync the linked GitHub issue's body from the current feature's spec, set its priority (p0..p3) / kind (bug|feature) / layer (frontend|backend|integration) labels, and split a full-stack feature into mock-first frontend, backend, and wire-up children (a manual run with no linked issue and no feature spec scans for duplicates and files directly from the description you give it — no /speckit-specify or /speckit-clarify required; a manual run inside a feature scans for duplicates and clarifies the spec with you first, then creates it)"
---

# Sync Feature Issue

Create or update the GitHub issue that tracks the current feature, rendering its body from the feature's `spec.md`.

`/speckit-git-feature` opens the tracking issue with a stub body (its number drives the spec/branch numbering). This command fills that stub in — and keeps it current on every later re-spec. It runs automatically on the `after_specify` hook, and can be invoked directly as `/speckit-git-issue` at any time.

This command is idempotent: re-running it rewrites the same issue body from the current spec rather than creating duplicates or appending. It only ever touches the issue **body** on the update path — the title belongs to `/speckit-git-feature`.

## Locating the Feature

Resolve the feature directory the same way the other git commands do:

1. `$SPECIFY_FEATURE_DIRECTORY` when set.
2. Otherwise `$SPECIFY_FEATURE`, else `specs/<branch>` derived from the current git
   branch. Never read the path out of `.specify/feature.json` — its
   `feature_directory` key is written for core Spec Kit's own resolver, and paths
   recorded in that file are how the git commands used to end up pointed at the
   *previous* feature (issue #33).

The spec is `<feature directory>/spec.md`.

- On the **hook** path, if neither can be resolved, stop with a clear error — the hook only ever fires right after `/speckit-specify` wrote one.
- On a **manual** invocation, a missing feature directory or `spec.md` is not an error — it means there is no spec to sync from, and the command falls into **Standalone Mode** below instead of failing.

## Three Invocation Modes

This one file drives multiple entry points, and they behave **differently** when no issue is linked:

| Mode | Trigger | No `source_issue` in `.specify/feature.json` |
|------|---------|----------------------------------------------|
| **Automatic hook** | the `after_specify` hook | **Skip cleanly.** Print a one-line notice and exit successfully. Create nothing. |
| **Manual, inside a feature** | the user types `/speckit-git-issue`, and a feature directory + `spec.md` resolve | May create a new issue, because the user asked for one explicitly — after the duplicate scan and clarification pass below. |
| **Manual, standalone** | the user types `/speckit-git-issue` with no feature directory/`spec.md` resolvable | Files directly from the title/description given in the invocation or the turn — see **Standalone Mode**. No spec, no clarify. |

Assume you are on the **hook** path unless the user invoked `/speckit-git-issue` directly in this turn. Within a manual invocation, assume you are **inside a feature** only when both the feature directory and `spec.md` resolve; otherwise you are **standalone**.

## Standalone Mode (No Spec)

Some issues don't warrant running `/speckit-specify` first — a quick bug report, a
one-line chore, something filed on the way to doing something else. Standalone mode
lets `/speckit-git-issue` file directly from whatever title/description the user
gives it, with no feature, no `spec.md`, and no `/speckit-clarify` pass.

1. **Get the content.** Use the title/description the user typed with the command
   (e.g. `/speckit-git-issue "Login button misaligned on mobile" more detail...`) or,
   if they invoked it bare, ask them for a one-line title and a short description
   with `AskUserQuestion` (free text) before doing anything else. Do not invent
   content — this mode has no spec to derive it from.
2. **Duplicate scan still runs**, exactly as in **Duplicate Scan Before Creating**
   below, using the given title. `--no-dupe-check` still skips it.
3. **No clarify pass.** `/speckit-clarify` operates on `spec.md`, which does not
   exist here — do not run it and do not reimplement the issue-shaped questions from
   **Clarify Before Creating**; the point of this mode is to file fast. If the
   description is clearly missing a definition of done or repro steps, ask for it in
   the same breath as the priority/kind question (one `AskUserQuestion` call), not as
   a separate pass.
4. **Priority & kind labels apply as normal** (see that section) — infer from the
   description using the same heuristic table, or ask when a human is in the loop.
5. **No layer split.** There is no spec to classify requirements by layer, so skip
   **Layer Split** entirely: no layer label, no `frontend`/`backend`/`wire-up`
   children. If the work later turns out to be full-stack, running
   `/speckit-git-feature --source-issue N` against this issue and then
   `/speckit-git-issue` from inside that feature will pick the split logic back up
   once a spec exists.
6. **Create the issue** with `gh issue create --title "<title>" --body "<description,
   rendered as-is>"`. There is no `.specify/feature.json` to write back to (standalone
   mode is not tied to a worktree), so nothing persists a `source_issue` — this is a
   plain GitHub issue with the duplicate-scan and labeling workflow attached, not a
   feature-tracking issue. Tell the user the issue number/URL when done.
7. **Everything else in this document — the update path, the clarify pass, the layer
   split — assumes a linked feature and does not apply here.**

Why the hook must not create: `/speckit-git-feature` owns the numbering contract — it opens the tracking issue *before* numbering so the spec dir, branch, and issue share one identifier. It deliberately bypasses issue creation when the caller opted out (`--timestamp`, `--number`, `GIT_BRANCH_NAME`, `--dry-run`) or when `gh` is unavailable. In all of those cases `.specify/feature.json` has no `source_issue`, and creating an issue here would either override an explicit opt-out or hard-fail `/speckit-specify` in a repo with no `gh`.

The skip notice should read roughly:

```
[speckit-git-issue] No tracking issue linked (no source_issue in .specify/feature.json) — skipping issue sync.
  /speckit-git-feature either opted out of issue-driven numbering (--timestamp / --number / GIT_BRANCH_NAME / --dry-run) or ran without gh.
  Run /speckit-git-issue manually if you want an issue created for this feature.
```

The hook stays registered with `optional: false` in `extension.yml`: it is mandatory in the sense that the agent must always *run* it, but running it on a feature with no linked issue is a successful no-op, so it can never break `/speckit-specify` for non-GitHub users.

## Jev Assist (optional)

Four judgment calls in this command are bounded enough for Jev (TypeSafe's System
One model) to answer in one fast call: is a candidate a **duplicate**, and the
**priority**, **kind** and **layer** of the work. Jev only replaces those pauses;
the scripts below still do every write. Call it through the extension's helper:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
JEV="$PROJECT_DIR/.specify/extensions/git/scripts/ts/jev.ts"
bun "$JEV" duplicate --new <new issue file> --candidate <candidate issue file>
bun "$JEV" priority  --issue <issue file>     # p0 | p1 | p2 | p3
bun "$JEV" kind      --issue <issue file>     # bug | feature
bun "$JEV" layer     --spec <spec.md>         # frontend | backend | full_stack | no_layer
```

The `<issue file>` is `spec.md` inside a feature, or a temp file holding the title
and description in standalone mode. Every call prints one JSON line; copy its
`record` field into your output, whatever the outcome.

- **Exit 0: act on `decision`**, as each section below says.
- **Exit 3: decide exactly as you would without Jev** — `SPECKIT_JEV=off`, no
  `TYPESAFE_API_KEY`, no SDK, an API error, a low-confidence answer, or a
  `duplicate` verdict in shadow mode. A non-null `verdict` on exit 3 may still be
  shown to a human as the recommended answer; it never decides on its own.
- **Exit 2**: your call was malformed. Fix it; never read it as a decision.

A `duplicate` verdict is **gated**: it decides only when `SPECKIT_JEV_AUTOMATE`
lists `duplicate` (or `all`); until then it exits 3 with the verdict shadowed.
`distinct` decides freely, because dropping a candidate only means asking less.
Never pass the API key on the command line; the helper reads `TYPESAFE_API_KEY`
from the environment only.

## Duplicate Scan Before Creating

Nothing in this command ever looked at what the repo already had, so a feature
specified twice in different words became two issues — both eligible for
autopilot's picker, both worked, the second one re-implementing or reverting the
first. On a **manual** run that is about to open a **new** issue, search the
existing issues first, and merge into the one that already covers this work
instead of filing a second thread.

The scan runs **before** the clarify pass: there is no point resolving a spec's
open questions for an issue you are about to merge into an existing thread that
already answers half of them.

| Path | Duplicate scan |
|------|----------------|
| Manual, inside a feature, no `source_issue` (about to create) | **Yes** — this is the default. |
| Manual, inside a feature, `source_issue` present (update) | Only with `--dupe-check`; the issue already exists. |
| Manual, standalone (no spec) | **Yes** — same scan, run against the given title. |
| `after_specify` hook | **Never** — it creates nothing, so there is nothing to duplicate. |
| Non-interactive / unattended | **Yes, but never blocks** — see step 4. |

`--no-dupe-check` skips the scan on any path.

### How

1. **Find candidates** with the shared script — never with a hand-rolled
   `gh issue list --search "<the whole title>"`, which ANDs every word of a
   sentence and reliably returns nothing:

   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   DUPES="$PROJECT_DIR/.specify/extensions/git/scripts/ts/find-duplicate-issues.ts"
   bun "$DUPES" --title "<the title this issue would get>" \
     [--keyword <distinctive term from the spec>]... [--exclude <issue to ignore>]
   ```

   It reduces the title to its distinctive tokens, searches each one separately,
   and prints the best candidates as
   `score<TAB>number<TAB>state<TAB>labels<TAB>updated<TAB>title<TAB>url`, best
   first. Add `--keyword` for terms that matter but are not in the title (an
   error string, a filename, a component). Closed issues are included on
   purpose: "we already fixed this" and "we already decided not to" are both
   answers worth having before filing.

   **Score ranks, it does not decide.** It counts term overlap, so a high score
   can still be an unrelated issue about the same subsystem and a low score can
   still be the same bug described in different words.

2. **Read the candidates before judging.** `gh issue view <n>` on anything
   plausible — the title alone is not enough to merge on. The test is *would
   closing one of these close the other?*, not *are these about the same file?*
   Two bugs in one module are two issues; the same bug reported twice is one.

   Then ask Jev that same question once per candidate (see **Jev Assist**),
   writing the prospective title + body and the candidate's title + body to
   temp files:

   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   JEV="$PROJECT_DIR/.specify/extensions/git/scripts/ts/jev.ts"
   NEW=$(mktemp); CAND=$(mktemp)
   printf '%s\n\n' "<prospective title>" > "$NEW"; cat <feature directory>/spec.md >> "$NEW"
   gh issue view <n> --json title,body --jq '.title + "\n\n" + .body' > "$CAND"
   bun "$JEV" duplicate --new "$NEW" --candidate "$CAND"
   ```

   In standalone mode the new file holds the given title and description.
   A candidate Jev decides `distinct` (exit 0) is **dropped**. If every
   candidate is dropped, the scan is clean — step 5, no question asked. Exit 3
   leaves the candidate to your own reading, as before.

3. **If a real candidate exists, ask the user with `AskUserQuestion`** — this
   decision is never made silently, in either direction. Name the candidate in
   the question (`#47 — [hindsight] Autopilot worktree-isolation guard refuses…`)
   and offer:

   | Option | What you do |
   |---|---|
   | **Merge into #N** | Adopt `#N` as this feature's tracking issue: set `source_issue` to `N` in `.specify/feature.json` (preserving every other key in the file) and take the **update** path. Create nothing. |
   | **File a new issue, cross-linked** | Create as normal, then add a `Related: #N` line to the new body and post one `gh issue comment N` pointing at the new issue. |
   | **Stop — I will work #N instead** | Create nothing, change nothing. Say which issue to run `/speckit-git-feature --source-issue N` against. |

   Lead with the option you would have chosen, marked `(Recommended)`, and put
   the candidate's state and title in the option description so the choice can be
   made without opening GitHub. When two or more candidates are strong, ask about
   the strongest and list the others in the question text. A `duplicate` verdict
   from Jev — decided or shadowed — makes **Merge into #N** the Recommended
   option for that candidate, and it is the one to ask about.

   This is its own `AskUserQuestion` call, asked **before** the clarify pass — it
   is not batched with the priority/kind picker, because every question in that
   batch is only worth asking once "are we even filing this?" is settled.

4. **When no human is in the loop** (any non-interactive session), never block
   and never guess a merge. Run the scan, and if any candidate scores well,
   **create nothing**: print the candidates and exit successfully, saying the
   feature is left unlinked pending a human's call. An unlinked feature is a
   supported configuration; a silently duplicated issue is not, and silently
   rewriting a stranger's issue body is worse than either.

   The one exception is Jev in automate mode: when exactly one candidate came
   back exit 0 with `decision` `duplicate`, merge into it (see **Merging into an
   existing issue**) and say in the output that Jev made the call, with its
   `record`. A shadowed verdict, or two decided duplicates, leaves the rule
   above unchanged.

5. **No candidates, or none that survive step 2** — say so in one line and carry
   on to the clarify pass. A clean scan is not a reason to invent a relationship.

### Merging into an existing issue

Adopting `#N` puts it on the update path, and **the update path regenerates the
body from `spec.md` on every later sync** — so anything the existing issue says
that is not in the spec is erased by the next `after_specify` run.

Before the first sync, fold that content into `spec.md`: reproduction steps into
the user scenarios, stated expectations into the functional requirements, and any
decision recorded in the thread into `## Clarifications` as a
`- Q: … → A: …` bullet. Only then render the body. Then post one
`gh issue comment N` saying the issue is now tracked by this feature and naming
the spec path, so the reporter can see what happened to their report.

`sync-issue-body.ts` keeps the reporter's own words on the issue regardless — the
first sync files them verbatim below the `<!-- speckit:original-report -->`
sentinel — but that is a safety net, not a substitute: the spec is what the next
run renders from, so anything left only in the preserved region is out of the
plan.

If the existing issue's original report cannot be reduced into the spec, that is
strong evidence it is **not** the same unit of work — go back to step 3 and file
separately.

## Clarify Before Creating

An issue is only as good as the questions asked before it was filed. On a **manual**
run that is about to open a **new** issue, resolve the spec's open questions *first*,
so the body describes a unit of work someone can pick up without a follow-up
conversation.

| Path | Clarify pass |
|------|--------------|
| Manual, inside a feature, no `source_issue` (about to create) | **Yes** — this is the default. |
| Manual, inside a feature, `source_issue` present (update) | Only when the user passes `--clarify` or asks for it in the turn. |
| Manual, standalone (no spec) | **Never.** There is no `spec.md` to run `/speckit-clarify` against — see **Standalone Mode**. |
| `after_specify` hook | **Never.** |
| Non-interactive / unattended (autopilot) | **Never** — nothing here may block on a human. |

`--no-clarify` skips the pass on any path; `--clarify` forces it (still a no-op when
no human is in the loop).

The hook path is excluded deliberately: `after_specify` fires seconds after the spec
was written, and the operator's very next step in the normal flow is `/speckit-clarify`
itself. Asking there asks twice.

### How

1. **Scan `spec.md` for unresolved ambiguity**: `[NEEDS CLARIFICATION: …]` markers,
   `TBD`/`TODO`, requirements with no observable outcome, and an absent or empty
   `## Clarifications` section.

2. **If any exist, run `/speckit-clarify` and wait for it to finish.** It is the right
   instrument, not something to reimplement here: at most 5 questions, asked one at a
   time, and it **writes the answers back into `spec.md`** — a bullet under
   `## Clarifications` *and* an edit to each requirement the answer changes.

   Durability is the whole reason to delegate rather than ask inline: this command
   **regenerates the issue body from `spec.md` on every later sync**, so an answer
   captured only in the issue body is erased by the next `after_specify` run. If it
   is not in the spec, it does not survive.

   Skip this step when the spec already carries a `## Clarifications` session and no
   markers remain — that ambiguity is already resolved.

3. **Re-read `spec.md` after clarify returns.** Rendering the body from the copy
   loaded before the pass publishes the pre-clarification spec, which is the exact
   failure this section exists to prevent.

4. **Ask the issue-shaped questions clarify does not cover.** `/speckit-clarify`
   optimizes a spec for planning; this command is filing a unit of work, and those are
   not the same gaps:

   | Gap in the spec | Ask |
   |---|---|
   | No closable definition of done | What must be true for this issue to be closed? |
   | A bug with no reproduction | The smallest steps to reproduce, and observed vs expected |
   | Scope with no edge | What is explicitly *out* of scope for this issue |
   | Layer genuinely ambiguous (see **Layer Split**) | frontend-only / backend-only / full-stack — it decides whether to split |

   Ask only the gaps still open after step 2, and put them in a **single**
   `AskUserQuestion` call **batched with the priority/kind question** from the next
   section, so the user answers one picker instead of three. That tool caps a call at
   4 questions: keep the highest-impact ones, and record anything you dropped as
   `## Open Questions` in the issue body rather than discarding it.

   Every answer is a spec change. **Write each one into `spec.md`** exactly the way
   clarify does — a `- Q: … → A: …` bullet under today's `### Session YYYY-MM-DD`
   heading in `## Clarifications`, plus the edit to the requirement it resolves — and
   only then render the body. Never let an answer live only in the issue.

5. **If the spec is already unambiguous, say so in one line and carry on.** A clean
   spec is not a reason to invent questions.

### Order of operations

On the manual create path: **duplicate scan → clarify → re-read `spec.md` → render
body → `gh issue create` → labels → layer split.** The scan comes first because a
merge means there is nothing to clarify or create; the split renders its children
from the clarified spec, so it stays last (and after the body sync — see
**Layer Split**).

When the scan ends in a merge, the path collapses to: **fold the existing issue's
report into `spec.md` → clarify (if the user asked) → render body → `gh issue edit`
→ labels → layer split**, exactly as if the issue had been linked all along.

## GitHub Issue Integration

This section covers the **hook** path and **manual, inside a feature** path. On
**manual, standalone**, skip straight to **Standalone Mode** above — there is no
`feature.json` to read or write.

1. Read `.specify/feature.json`.
2. **If it has a numeric `source_issue` — update that issue's body only, with the shared script:**

   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   SYNC="$PROJECT_DIR/.specify/extensions/git/scripts/ts/sync-issue-body.ts"
   bun "$SYNC" <source_issue> <feature directory>/spec.md
   ```

   Never hand-write the render or the `gh issue edit`. This command used to
   describe both in prose, so the model re-derived them in a fresh heredoc every
   run — four unattended runs in one day, four incompatible schemes for the human
   report the sync overwrites (issue #63). The script owns all of it: it renders
   the spec's `##` sections (see **Issue Body**), preserves the issue's existing
   body verbatim below the `<!-- speckit:original-report -->` sentinel on the
   first sync and carries that region across untouched on every later one,
   carries the `<!-- speckit:work-breakdown -->` block through, and refuses to
   write (exit 2) rather than publish a body that lost either. `--dry-run` prints
   the composed body without editing.
   **Do NOT pass `--title`.** `/speckit-git-feature` already set the title to `NNN: <feature description>` and owns it. The spec's H1 is the template heading (`Feature Specification: …`), not that title — writing it back would rewrite issue #N's title to something like `23: Feature Specification: …` on every re-spec.
   Then apply the triage labels (see **Priority & Kind Labels** below) — on this path only for axes the issue does not already carry.
   Here `gh` **MUST** be installed and authenticated: a linked issue that cannot be updated is a genuinely broken state. If `gh` is missing, `gh auth status` fails, or `gh issue edit` exits non-zero, stop with a clear error — never silently skip the sync.
3. **If there is no `source_issue`:**
   - On the **hook** path: print the skip notice above and exit successfully.
   - On a **manual** invocation, once the **Duplicate Scan** has cleared the create
     (a merge takes path 2 instead, against the adopted issue): create one by rendering
     the body with the same script and handing the file to `gh`:

     ```bash
     bun "$SYNC" --render-only <feature directory>/spec.md > /tmp/issue-body.md
     gh issue create --title "<title>" --body-file /tmp/issue-body.md
     ```

     `--render-only` skips the preservation surgery because a brand-new issue has
     nothing to preserve; every later sync takes path 2 above.
     then parse the issue number out of the returned URL and persist it back into `.specify/feature.json` as a numeric `source_issue`, preserving every other key in the file. Subsequent runs then take the update path. Then apply the triage labels (see **Priority & Kind Labels** below). Use the spec's H1 as the title, prefixed with the feature number when the branch/spec is numbered (e.g. `008: User Auth`). This is the only path that may set a title.

## Priority & Kind Labels

Every tracking issue carries two triage labels: a priority (`p0`, `p1`, `p2`, `p3`) and a kind (`bug` or `feature`). They are not cosmetic — `/speckit-autopilot-run` orders its backlog by (priority, bug-before-feature, age), so an unlabelled issue is worked in plain filing order and a real P0 waits behind an older chore.

Apply them with the shared script — never with a hand-rolled `gh issue edit --add-label`, which would drift from the vocabulary the picker matches on and can leave an issue carrying two priorities at once:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
LABEL_SCRIPT="$PROJECT_DIR/.specify/extensions/git/scripts/ts/label-issue.ts"
bun "$LABEL_SCRIPT" <issue-number> --show                          # read current triage labels
bun "$LABEL_SCRIPT" <issue-number> --priority p1 --kind bug        # set them (each is exclusive)
bun "$LABEL_SCRIPT" <issue-number> --layer frontend --mock-first   # layer axis + markers
```

The same script owns the **layer** axis (`frontend`/`backend`/`integration`, also
exclusive) and the `mock-first` / `epic` markers — see **Layer Split** below.

Run this on **both** paths — after creating an issue, and after updating an existing one — using this policy:

1. **Read what is already there** (`--show`). A priority the human already set is authoritative: leave it alone and do not ask again. Set only the axis that is missing.
2. **The user supplied a priority or kind in their invocation** (e.g. `/speckit-git-issue p0 bug`, or said so in the turn) → use it verbatim, no question.
3. **Otherwise ask Jev first**, for each axis still missing (see **Jev Assist**):

    ```bash
    PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
    JEV="$PROJECT_DIR/.specify/extensions/git/scripts/ts/jev.ts"
    bun "$JEV" priority --issue <feature directory>/spec.md
    bun "$JEV" kind     --issue <feature directory>/spec.md
    ```

    In standalone mode pass a temp file holding the title and description instead.

    Its `verdict` (exit 0 or 3) replaces your inference as the Recommended option
    in (4); a `kind` verdict counts as an unambiguous spec, so kind is not asked.
    In (5) an exit-0 `decision` replaces the inference outright; exit 3 infers as
    below.
4. **Otherwise, when a human is in the loop, ask.** When the **Clarify Before Creating** pass is running, this question goes in the *same* `AskUserQuestion` call as the issue-shaped ones — do not open a second picker for it. Use `AskUserQuestion` with the priority options `P0 — critical`, `P1 — high`, `P2 — normal`, `P3 — low`, and lead with the one you would have inferred, marked `(Recommended)`, so accepting the default is one keystroke. Ask for the kind in the same call **only when the spec is genuinely ambiguous** — a spec describing broken behaviour is a `bug` and one describing new capability is a `feature`, and asking about the obvious wastes the user's turn.
5. **When no human is in the loop** — the `after_specify` hook during an unattended run, or any non-interactive session — do **not** block. Infer both from the spec and apply them, then say in your output which values were inferred or Jev-decided (with the `record`) rather than chosen, so a human skimming the issue can correct a bad guess.

Inference heuristic, used for the recommendation in (4) and the unattended path in (5) whenever Jev returned no verdict:

| Signal in the spec / issue | Label |
|---|---|
| Data loss, security hole, broken build, outage, everything blocked | `p0` |
| A user-facing feature is broken or unusable, no workaround | `p1` |
| Ordinary defect with a workaround, or ordinary new capability | `p2` |
| Polish, cleanup, nice-to-have, speculative | `p3` |
| Restores intended behaviour that is currently broken | `bug` |
| Adds or extends behaviour | `feature` |

`p2` is the deliberate default: it is also the rank the picker assumes for an unlabelled issue, so guessing it changes nothing about ordering and never fakes an urgency nobody asserted.

Label failures are **soft**: if `gh` cannot apply a label (missing repo permission, unusual label protection), print the warning the script emits and carry on — the issue body sync is the job, and an unlabelled issue is still a working issue.

## Layer Split: Frontend, Backend, Wire-Up

A feature that touches **both** the UI and the API is not one unit of work, and this
command does not file it as one. After the body sync and the triage labels, decide
whether the spec is full-stack; if it is, split it.

**Every frontend child is mock-first.** The UI is built against static in-repo
fixtures with **no network calls at all** — no `fetch`, no API client, no MSW
handler, no live endpoint. That is the whole point: the mock UI can be started
immediately, reviewed on its own, and it freezes the data shape the backend then
implements. The fixtures are retired by the wire-up child, never left behind.

### Deciding

Read the spec and classify each functional requirement:

| The requirement is about | Layer |
|---|---|
| Rendered UI, a screen, a component, interaction, styling, client-side state | frontend |
| An endpoint, schema, migration, job, auth check, business rule, external call | backend |
| Only connecting the two | integration |

- **Both frontend and backend requirements present → split.** This is the default
  for anything a user can see that also stores or fetches something.
- **Only one layer → do not split.** Apply that layer label to the tracking issue
  itself (`--layer frontend --mock-first`, or `--layer backend`) and stop. A
  frontend-only feature that consumes an API that *already exists* is still
  `--layer frontend` but **not** `mock-first` — there is nothing to mock.
- **Neither layer applies** (tooling, docs, CI, a library with no UI and no API):
  no layer label, no split.

Ask Jev first (see **Jev Assist**); an exit-0 `decision` replaces the table above:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
JEV="$PROJECT_DIR/.specify/extensions/git/scripts/ts/jev.ts"
bun "$JEV" layer --spec <feature directory>/spec.md
```

| `decision` | Do |
|---|---|
| `frontend` | `--layer frontend`, no split — `--mock-first` unless the API already exists |
| `backend` | `--layer backend`, no split |
| `full_stack` | split |
| `no_layer` | no layer label, no split |

Exit 3 → classify with the table as before, and put the layer in the clarify batch
when it is still genuinely ambiguous. Jev never decides `mock-first`: whether the
API already exists is read from the spec and the code, by the rule above.

### Splitting

Render three bodies from the spec — the frontend requirements, the backend
requirements, and optionally the wire-up — to files, then run the shared script.
Never open the children with hand-rolled `gh issue create`: the script owns the
titles, the parent's work-breakdown block, the `Blocked by:` line, and the labels.

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
SPLIT="$PROJECT_DIR/.specify/extensions/git/scripts/ts/split-issue.ts"
bun "$SPLIT" <parent-issue> --show                 # already split? prints "<layer> <number>"
bun "$SPLIT" <parent-issue> \
  --title "<feature title, no layer prefix>" \
  --frontend-body /tmp/fe.md --backend-body /tmp/be.md \
  [--integration-body /tmp/int.md] \
  --priority p1 --kind feature
```

What the script does, so you do not duplicate any of it:

- Creates `frontend(mock): <title>`, `backend: <title>`, `wire-up: <title>` — in
  that order, because autopilot breaks equal-priority ties by age, so the mock UI
  is picked first without any rule in the picker.
- Labels them `frontend`+`mock-first`, `backend`, `integration`, and copies the
  parent's `--priority`/`--kind` onto all three.
- Writes `Blocked by: #<fe>, #<be>` into the wire-up child, which
  `preflight-issues.ts` reads — autopilot will not touch it until both siblings
  close.
- Rewrites the parent's `<!-- speckit:work-breakdown -->` block and labels the
  parent `epic`, which is in autopilot's block set. **The parent is no longer
  worked directly** — that is deliberate; working it would re-implement all three
  children in one pass.
- Is idempotent: it reads the existing children out of the parent's block and
  **edits** their bodies on a re-run rather than opening a second set. Run it on
  every re-spec.

Because the parent body rewrite appends the breakdown block, **run the split after
the body sync**, never before. `sync-issue-body.ts` carries an existing block
through and re-emits it last, so the ordering is now belt-and-braces rather than the
only thing standing between a re-spec and three duplicate children — but a
hand-rolled `gh issue edit --body` still erases it, which is one more reason not to
write one.

### The frontend child's body

Write it so an implementer cannot accidentally reach the network. Include, in the
functional requirements:

- The fixture module(s) to add and the shape of the data they return — this is the
  contract the backend child implements, so be concrete about field names and types.
- Every state the UI must render from fixtures: populated, empty, loading, error.
- An explicit prohibition: no network calls, no API client, no server dependency;
  the feature must be fully exercisable with the backend absent.
- How it is demonstrated (a route, a story, a screenshot) so the mock is reviewable
  on its own.

### The backend child's body

- The endpoints/schema/rules, stated against the same field names the fixtures use.
- Explicitly out of scope: any UI change. A backend PR that touches components is
  the split failing.

### Not splitting a child

A child issue already carries a layer label and a `Parent: #N` line in its body.
When this command runs during work on a child (autopilot picks #43, `/speckit-specify`
fires the `after_specify` hook), sync its body and **stop** — never split a child.
Check with `bun "$SPLIT" <issue> --show` or simply look for the layer label.

## Issue Body

`sync-issue-body.ts` renders this; the shape is documented here so you can read
what it produced, not so you can reproduce it by hand. It derives the body from
**whatever sections `spec.md` actually contains** — it does not assume a fixed set. Presets may add or remove sections, so read the file and render only the headings that are present. If a section is absent, skip its heading entirely rather than emitting an empty one.

```markdown
Spec path: <feature directory>/spec.md

<one-paragraph summary of the feature>

## User Scenarios

<condensed from the spec's user scenarios section>

## Functional Requirements

<the spec's functional requirements>

## Clarifications

<the spec's Clarifications session(s), verbatim — this is where the answers from
 the clarify pass live, and they are only here because they are in spec.md>

## Open Questions

<only when something was asked and left unanswered: one bullet each, so the gap is
 recorded on the issue instead of lost>

## Notes

Generated/updated by /speckit-git-issue
```

`## Clarifications` and `## Open Questions` follow the same rule as every other
section — render them only when there is content. `## Clarifications` comes from
`spec.md`, never from this command's own memory of the conversation.

The script drops the spec's H1 (the template heading), omits `## Success Criteria`
by default, and appends the `## Notes` line. `--omit "<heading>"` drops another
section and `--include "Success Criteria"` puts that one back. When you have a
reason to compose the body yourself — folding a merged issue's report in, say —
write it to a file and pass `--body-file`, which keeps the sentinel and the
preservation surgery while letting you own the prose.

**`## Success Criteria` is deliberately omitted.** Presets such as `spec-minimal` strip that section out of `spec.md`, so demanding it here would require inventing content that does not exist. The same reasoning applies to any other optional section: render it only if the spec has it.

## Failure Modes

| Situation | Behavior |
|-----------|-----------|
| No `source_issue`, hook path | **Clean skip**, exit 0 with the notice above. Nothing created. |
| No `source_issue`, manual path | Create the issue; `gh` missing/unauthenticated/failing → hard error. |
| `source_issue` present, `gh` missing or unauthenticated | **Hard error** with an install / `gh auth login` hint. |
| `source_issue` present, `gh issue edit` non-zero exit | **Hard error**, surfacing `gh`'s own message. |
| `sync-issue-body.ts` exits 2 | **Hard error, nothing written.** The composed body would have dropped the preserved report or the work-breakdown block; the issue on GitHub is untouched. Never "fix" it with a hand-rolled `gh issue edit`. |
| No feature directory or no `spec.md`, hook path | **Hard error** — the hook only fires right after `/speckit-specify` wrote one, so its absence means something is genuinely broken. |
| No feature directory or no `spec.md`, manual path | **Not an error.** Falls into **Standalone Mode**: file from the given/asked-for title and description, no spec, no clarify. |
| Standalone mode, user gave no title/description and didn't answer when asked | **Create nothing.** Say the issue was not filed for lack of content. |
| `find-duplicate-issues.ts` fails, or `gh`/`jq` is missing | **Warn and continue.** The scan is a safety net, not the sync — say in the output that the create was unscanned so a human knows to check. |
| Duplicate scan finds candidates, no human in the loop | **Create nothing**, exit 0, print the candidates. The feature stays unlinked. |
| User picks **Merge into #N** | Write `source_issue: N`, fold #N's report into `spec.md`, then take the normal update path. Never `gh issue create`. |
| `--no-dupe-check` passed | Skip the scan silently; everything downstream is unchanged. |
| `/speckit-clarify` missing or failing on the create path | **Warn and continue.** Ask the issue-shaped questions inline instead and write the answers into `spec.md` yourself. A missing clarify command is not a reason to file nothing. |
| Create path, no human in the loop | **Ask nothing.** Render from the spec as-is and say in the output that the issue was filed unclarified. |
| `--no-clarify` passed | Skip the pass silently; everything downstream is unchanged. |
| `label-issue.ts` fails or is missing | **Warn and continue.** Labels improve autopilot's ordering; they are not the sync. |
| Spec is single-layer, or neither layer | **No split.** Label the layer if one applies and stop. |
| Issue already carries a layer label / `Parent: #N` | **No split** — it is already a child. |
| `split-issue.ts` fails after creating some children | **Hard error.** A half-written breakdown is a broken state; the script's own message names which children exist, and a re-run adopts them rather than duplicating. |

The rule: once an issue *is* linked, a failed sync is a real broken state worth stopping for. An absent link is not a failure — it is a supported configuration.
