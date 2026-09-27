#!/usr/bin/env bun
// Check the git extension's spec->issue body render: what it renders, what it
// preserves, and that a re-sync is byte-stable (issues #61, #63).
//
// Usage: bun test-sync-issue-body.ts

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SYNC = join(import.meta.dir, "extensions/git/scripts/ts/sync-issue-body.ts");
const TMP = mkdtempSync(join(tmpdir(), "test-sync-issue-body-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
let fail = 0;

const ORIG_BEGIN = "<!-- speckit:original-report -->";
const ORIG_END = "<!-- /speckit:original-report -->";
const WB_BEGIN = "<!-- speckit:work-breakdown -->";
const WB_END = "<!-- /speckit:work-breakdown -->";

function contains(what: string, needle: string, hay: string) {
  if (hay.includes(needle)) console.log(`  ok: ${what} contains '${needle}'`);
  else {
    console.error(`  FAIL: ${what} does not contain '${needle}'`);
    console.error(hay.split("\n").map((l) => `        ${l}`).join("\n"));
    fail = 1;
  }
}
function lacks(what: string, needle: string, hay: string) {
  if (hay.includes(needle)) { console.error(`  FAIL: ${what} unexpectedly contains '${needle}'`); fail = 1; }
  else console.log(`  ok: ${what} omits '${needle}'`);
}
function check(what: string, desc: string, want: unknown, got: unknown) {
  if (want === got) console.log(`  ok: ${what} ${desc}`);
  else { console.error(`  FAIL: ${what} ${desc} — expected '${want}', got '${got}'`); fail = 1; }
}
// Runs the script; `out` is a `$(…)` capture (trailing newlines stripped).
function sync(args: string[], opts: { env?: Record<string, string | undefined>; mergeStderr?: boolean } = {}) {
  const r = Bun.spawnSync([process.execPath, SYNC, ...args], { env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + (opts.mergeStderr ? r.stderr.toString() : "");
  return { rc: r.exitCode, out: out.replace(/\n+$/, "") };
}

const SPEC = join(TMP, "spec.md");
writeFileSync(SPEC, `# Feature Specification: Saved Searches

Users can save a search and re-run it later.

## User Scenarios

- A user saves a search from the results page.

## Functional Requirements

- FR-001: the list persists across sessions.

## Success Criteria

- SC-001: 95% of saves complete in under 200ms.

## Clarifications

### Session 2026-09-10

- Q: How many saved searches? -> A: 20.
`);

const REPORT = join(TMP, "report.md");
writeFileSync(REPORT, `The saved-search list disappears after a reload.

Steps: save a search, reload, list is empty.
Expected: the search is still there.
`);

console.log("1. render: spec sections in, H1 and Success Criteria out");
const { rc: rc1, out } = sync(["41", SPEC, "--current-body", REPORT, "--dry-run"]);
check("render", "exit code", 0, rc1);
contains("render", `Spec path: ${SPEC}`, out);
contains("render", "## Functional Requirements", out);
contains("render", "FR-001: the list persists across sessions.", out);
contains("render", "## Clarifications", out);
contains("render", "Generated/updated by /speckit-git-issue", out);
lacks("render", "# Feature Specification: Saved Searches", out);
lacks("render", "## Success Criteria", out);
lacks("render", "SC-001", out);

console.log("2. first sync preserves the human report below the sentinel");
contains("preserve", ORIG_BEGIN, out);
contains("preserve", ORIG_END, out);
contains("preserve", "The saved-search list disappears after a reload.", out);
contains("preserve", "Expected: the search is still there.", out);
// --include puts a default-omitted section back.
const inc = sync(["41", SPEC, "--current-body", REPORT, "--include", "Success Criteria", "--dry-run"]).out;
contains("--include", "SC-001", inc);

console.log("3. re-sync is byte-stable — the preserved region is not re-wrapped");
const SYNCED = join(TMP, "synced.md");
writeFileSync(SYNCED, `${out}\n`);
const again = sync(["41", SPEC, "--current-body", SYNCED, "--dry-run"]).out;
check("re-sync", "is idempotent", out, again);
check("re-sync", "has exactly one begin sentinel", 1, again.split("\n").filter((l) => l.includes(ORIG_BEGIN)).length);

console.log("4. an edited spec rewrites only the region above the sentinel");
writeFileSync(SPEC, readFileSync(SPEC, "utf8").replace("FR-001: the list persists across sessions.", "FR-001: the list syncs across devices."));
const edited = sync(["41", SPEC, "--current-body", SYNCED, "--dry-run"]).out;
contains("edited", "FR-001: the list syncs across devices.", edited);
lacks("edited", "FR-001: the list persists across sessions.", edited);
contains("edited", "The saved-search list disappears after a reload.", edited);

const STUB_TEXT = "Tracking issue for feature: saved searches\n\nStub created by `/speckit-git-feature`. The full spec body will be filled in by `/speckit-specify`.\n";

console.log("5. a /speckit-git-feature stub is not preserved as a report");
writeFileSync(join(TMP, "stub.md"), STUB_TEXT);
const stub = sync(["41", SPEC, "--current-body", join(TMP, "stub.md"), "--dry-run"]).out;
lacks("stub", ORIG_BEGIN, stub);
lacks("stub", "Stub created by", stub);
contains("stub", "## Functional Requirements", stub);

console.log("5b. a reporter's edit to a stub survives the first sync");
writeFileSync(join(TMP, "stub-edited.md"), `${STUB_TEXT}
Repro: save a search, reload the page, the list is empty.
Expected: the saved search is still listed.
`);
const { rc: rc5b, out: se } = sync(["41", SPEC, "--current-body", join(TMP, "stub-edited.md"), "--dry-run"]);
check("edited stub", "exit code", 0, rc5b);
contains("edited stub", ORIG_BEGIN, se);
contains("edited stub", "Repro: save a search, reload the page, the list is empty.", se);
contains("edited stub", "Expected: the saved search is still listed.", se);
lacks("edited stub", "Stub created by", se);
lacks("edited stub", "Tracking issue for feature:", se);

console.log("6. the work-breakdown registry survives a body sync, and lands last");
writeFileSync(join(TMP, "split.md"), `${readFileSync(SYNCED, "utf8")}\n${WB_BEGIN}\n## Work breakdown\n\n- [ ] frontend — mock first, fixtures only: #42\n${WB_END}\n`);
const wb = sync(["41", SPEC, "--current-body", join(TMP, "split.md"), "--dry-run"]).out;
contains("work-breakdown", "- [ ] frontend — mock first, fixtures only: #42", wb);
check("work-breakdown", "block is last", WB_END, wb.split("\n").filter((l) => l !== "").at(-1));
const wbLines = wb.split("\n");
lacks("work-breakdown", "#42", wbLines.slice(0, wbLines.findIndex((l) => l.includes(ORIG_END)) + 1).join("\n"));

console.log("7. --body-file supplies the rendered region; preservation is unchanged");
writeFileSync(join(TMP, "pre.md"), "A body the caller rendered itself.\n");
const pre = sync(["41", "--body-file", join(TMP, "pre.md"), "--current-body", REPORT, "--dry-run"]).out;
contains("--body-file", "A body the caller rendered itself.", pre);
contains("--body-file", "The saved-search list disappears after a reload.", pre);

console.log("8. it edits the real issue through gh --body-file, and prints the URL");
mkdirSync(join(TMP, "bin"));
// gh issue view N --json body|url --jq ... | gh issue edit N --body-file F
writeFileSync(join(TMP, "bin/gh"), `#!/usr/bin/env bun
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[1] === "view") {
  if (a.join(" ").includes("--json url")) console.log("https://github.com/o/r/issues/41");
  else process.stdout.write(fs.readFileSync(process.env.GH_STUB_BODY));
  process.exit(0);
}
if (a[1] === "edit") {
  const i = a.indexOf("--body-file");
  if (i >= 0) fs.copyFileSync(a[i + 1], process.env.GH_STUB_EDITED);
  process.exit(0);
}
process.exit(1);
`);
chmodSync(join(TMP, "bin/gh"), 0o755);
const EDITED = join(TMP, "edited.md");
const { rc: rc8, out: out8 } = sync(["41", SPEC], {
  env: { PATH: `${join(TMP, "bin")}:${process.env.PATH}`, GH_STUB_BODY: REPORT, GH_STUB_EDITED: EDITED },
  mergeStderr: true,
});
check("gh", "exit code", 0, rc8);
contains("gh", "https://github.com/o/r/issues/41", out8);
let editedBody = "";
try { editedBody = readFileSync(EDITED, "utf8"); } catch {}
contains("gh", "The saved-search list disappears after a reload.", editedBody);

console.log("9. --render-only is the create path: no issue number, no gh, no sentinel");
// A PATH holding bun and nothing else beyond the base system, so a stray `gh`
// call cannot succeed by accident.
mkdirSync(join(TMP, "bunonly"));
symlinkSync(process.execPath, join(TMP, "bunonly/bun"));
const { rc: rc9, out: ro } = sync(["--render-only", SPEC], { env: { PATH: `${join(TMP, "bunonly")}:/usr/bin:/bin` } });
check("--render-only", "exit code", 0, rc9);
contains("--render-only", "## Functional Requirements", ro);
lacks("--render-only", ORIG_BEGIN, ro);

console.log("10. usage errors are refusals, not partial writes");
check("missing spec", "exit code", 1, sync(["41", join(TMP, "nope.md"), "--current-body", REPORT, "--dry-run"]).rc);
check("non-numeric issue", "exit code", 1, sync(["notanumber", SPEC, "--dry-run"]).rc);

console.log("11. an unclosed report sentinel is a refusal, not a silent truncation");
const UNCLOSED = join(TMP, "unclosed.md");
writeFileSync(UNCLOSED, `Rendered region from an earlier sync.\n\n## Original report (as filed)\n\n${ORIG_BEGIN}\nThe saved-search list disappears after a reload.\nExpected: the search is still there.\n`);
const { rc: rc11, out: unc } = sync(["41", SPEC, "--current-body", UNCLOSED, "--dry-run"], { mergeStderr: true });
check("unclosed sentinel", "exit code", 2, rc11);
contains("unclosed sentinel", "nothing written", unc);
lacks("unclosed sentinel", "## Functional Requirements", unc);
// The same body with its closing sentinel back is synced normally, last line and all.
appendFileSync(UNCLOSED, `${ORIG_END}\n`);
const { rc: rcC, out: closed } = sync(["41", SPEC, "--current-body", UNCLOSED, "--dry-run"]);
check("closed sentinel", "exit code", 0, rcC);
contains("closed sentinel", "Expected: the search is still there.", closed);

if (fail === 0) console.log("all cases passed");
else console.error("FAILURES");
process.exit(fail);
