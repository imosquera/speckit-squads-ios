# spec-kit-preset-explicit-task-dependencies

A [Spec Kit](https://github.com/github/spec-kit) preset that adds explicit inter-task dependency declarations and an Execution Wave DAG to generated `tasks.md` documents.

## What it does

- Extends the task checklist format with an optional `(depends on T###, T###)` suffix for explicit task-level dependencies
- Replaces the "Parallel Example" section with a structured **Execution Wave DAG** that groups tasks by dependency resolution order
- Updates the `/speckit.tasks` command to instruct dependency suffix usage and Wave DAG generation

## Installation

```bash
specify preset add --from https://github.com/Quratulain-bilal/spec-kit-preset-explicit-task-dependencies/archive/refs/tags/v1.0.0.zip
```

## What gets overridden

| Type | Name | Description |
|------|------|-------------|
| Template | tasks-template | Adds `(depends on ...)` suffix, `[Story?]` optionality, cross-phase dependencies, and Execution Wave DAG |
| Command | speckit.tasks | Instructs dependency suffix generation, Wave DAG creation, and clarifies Task ID as declaration order |

## Design decisions

- **Explicit over implicit**: All dependencies are declared per-task, including cross-phase references — no implicit phase-boundary assumptions
- **Task IDs are declaration order**: Sequential identifiers (T001, T002...) follow declaration order; actual execution order is derived from the Wave DAG
- **`[P]` with dependencies**: Tasks marked `[P]` can run in parallel with other ready tasks once their listed dependencies are satisfied
- **`[Story?]` optionality**: Story label is required only for user story phases, not Setup/Foundational/Polish phases
- **Complete Wave DAG**: All sample tasks (US1, US2, US3) appear in the DAG — no partial excerpts
- **Monotonic IDs in DAG**: Task IDs within each wave are monotonically ordered to avoid confusion

## Requirements

- Spec Kit >= 0.4.0

## License

MIT
