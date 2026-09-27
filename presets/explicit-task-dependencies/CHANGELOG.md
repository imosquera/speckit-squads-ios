# Changelog

## 1.1.0 (2026-05-29)

- Add `/speckit-implement` override that walks the Execution Wave DAG and dispatches each wave's `[P]`-marked tasks to subagents in a single tool-call batch, then runs the wave's non-`[P]` tasks inline before advancing.
- Fail loudly when `tasks.md` lacks a `## Execution Wave DAG` section instead of silently falling back to sequential execution — the preset's value depends on the DAG being present.

## 1.0.0 (2026-04-07)

- Initial release
- Add explicit `(depends on T###)` dependency suffix to task checklist format
- Add Execution Wave DAG section replacing Parallel Example
- Update `/speckit.tasks` command with dependency and Wave DAG generation instructions
- Cross-phase dependencies declared explicitly on all sample tasks
- Task IDs clarified as declaration order, not execution order
