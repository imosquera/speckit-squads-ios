---
description: Execute tasks.md, dispatching each wave's tasks to subagents
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty). Treat empty arguments as "run every unchecked task."

## Pre-Execution Checks

Run the standard `before_implement` hook chain exactly as the canonical `/speckit-implement` does (worktree `cd`, auto-commit prompts, etc.). This preset changes *how* tasks are executed, not whether hooks fire.

## Outline

### 1. Load the feature

1. Resolve the feature directory as `specs/<branch>`, where `<branch>` is the current
   git branch with any leading path segment stripped (`feat/014-x` → `014-x`), unless
   `SPECIFY_FEATURE_DIRECTORY` or `SPECIFY_FEATURE` overrides it. Do not read the
   directory from `.specify/feature.json` — a feature's paths are always derived from
   git, never read out of that file (issue #33). Its `feature_directory` key is there
   for core Spec Kit's own resolver, not for you.
2. Read `<feature_dir>/tasks.md`. If the file is missing or has no `## Execution Wave DAG` section, ERROR with:

   ```
   tasks.md has no Execution Wave DAG. This preset (explicit-task-dependencies)
   requires the matching speckit.tasks override that emits the DAG. Re-run
   /speckit-tasks under this preset, or remove this preset to use the default
   sequential implementer.
   ```

   Do NOT fall back to sequential execution — fail loudly so the user can fix the setup.

3. Read `<feature_dir>/plan.md` and `<feature_dir>/spec.md` for context. Do not re-read them between waves.

### 2. Walk the DAG, one wave at a time

For each `Wave N` block in `## Execution Wave DAG`, in order:

1. **Collect the wave's task IDs.** Skip any that are already `[x]` in the task list.

2. **Partition the wave**:
   - **Parallel set**: tasks whose line in the main task list carries the `[P]` marker.
   - **Sequential set**: tasks without `[P]`. These run inline in declaration order *after* the parallel set completes.

   The DAG guarantees inter-wave ordering. `[P]` controls intra-wave parallelism.

3. **Dispatch the parallel set.** In a **single assistant message**, emit one `Agent` tool call per parallel task. Do not batch them across multiple messages — the point of this preset is wave-level concurrency, which only works when every Agent call in the wave is sent together.

   Each Agent call's prompt MUST include:
   - The task ID and exact task line from tasks.md (verbatim).
   - The file path(s) named in the task description.
   - A pointer to `<feature_dir>/plan.md` and `<feature_dir>/spec.md` for context.
   - The dependency list (so the subagent knows what state to assume already exists).
   - An instruction to make ONLY the changes the task describes — no opportunistic refactors, no cross-task edits.
   - An instruction to report back in under 100 words: what changed, file paths touched, anything blocking.

   Default `subagent_type` is `general-purpose`. Use a more specific type only when the task's nature obviously matches one (e.g. a UI task → a frontend-design agent if present in the project).

4. **Wait for the wave's parallel set to fully return** before dispatching the sequential set or moving to the next wave. The harness returns Agent results when they complete; do not advance until every parallel task in the wave has reported.

5. **Run the sequential set inline** (not via subagents) — these are tasks the original DAG identified as order-sensitive within the wave (e.g. shared-file edits).

6. **Mark each completed task `[x]` in tasks.md** as soon as its agent (or inline run) reports success. Do not batch the checkbox updates across waves.

### 3. Failure handling

- If a subagent reports it could not complete a task: do NOT proceed to the next wave. Surface the failure, the agent's report, and the affected task IDs. Ask the user whether to retry, skip, or abort.
- If a subagent reports it touched files outside the ones named in its task description: flag this in your end-of-wave summary. It is usually a sign the task was under-specified, not a sign to suppress the warning.

### 4. End-of-run summary

After the last wave, print:
- Total tasks executed, broken down by parallel-via-subagent vs. inline-sequential vs. skipped-already-done.
- Wall-clock-equivalent serialization estimate (sum of all task durations) vs. actual elapsed (sum of wave durations) — the speedup is the whole point of this preset.
- Any tasks left unchecked, with the reason.

## Why subagents instead of inline execution

The default `/speckit-implement` executes tasks serially in the main agent. For features with wide DAGs (e.g. five independent model files, four independent endpoints) this leaves parallelism on the floor and inflates context usage in the main agent. Dispatching parallel-safe tasks to fresh subagents:

- Cuts wall-clock time roughly by `serial_sum / wave_max` per wave.
- Keeps the main agent's context lean — only task lines and per-agent summaries land in main context, not the full edited files.
- Surfaces task-level failures in isolation, so one broken task doesn't poison the surrounding context.

The cost is more tool-use overhead per task; for trivial features (one or two tasks per wave) the default implementer is fine. This preset assumes you opted into the wave DAG because the feature was wide enough to be worth parallelizing.

## What this command does NOT change

- Does not modify `tasks.md` beyond marking checkboxes.
- Does not reorder, merge, or split tasks — the DAG is the contract.
- Does not run `after_implement` hooks differently — those fire from the standard hook chain after the last wave completes.
