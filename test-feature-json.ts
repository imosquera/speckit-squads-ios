#!/usr/bin/env bun
// Self-check for the feature.json sidecar contract (issue #78): core Spec Kit
// overwrites .specify/feature.json and drops source_issue; the sidecar restores it.
// Run: ./test-feature-json.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as gc from "./extensions/git/scripts/ts/git-common.ts";

const TMP = mkdtempSync(`${tmpdir()}/feature-json-`);
const json = `${TMP}/.specify/feature.json`;
const read = () => {
  try {
    return readFileSync(json, "utf8");
  } catch {
    return "";
  }
};
const realError = console.error;
const quiet = <T>(f: () => T): T => {
  console.error = () => {};
  try {
    return f();
  } finally {
    console.error = realError;
  }
};
function check(cond: boolean, msg: string): void {
  if (cond) return;
  console.error(`FAIL: ${msg} (feature.json: ${read()})`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

try {
  Bun.spawnSync(["git", "-C", TMP, "init", "-q"]);
  Bun.spawnSync(["git", "-C", TMP, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const sidecar = gc.sourceIssueSidecar(TMP)!;

  // 1. Writing the link merges (issue #70) and mirrors to the sidecar.
  mkdirSync(`${TMP}/.specify`, { recursive: true });
  writeFileSync(json, '{"feature_directory":"specs/078-x"}\n');
  quiet(() => gc.writeFeatureJson(TMP, "78"));
  check(read().includes('"feature_directory":"specs/078-x"'), "merge dropped feature_directory");
  check(gc.featureSourceIssue(TMP) === "78", "merge dropped source_issue");
  check((statSync(sidecar, { throwIfNoEntry: false })?.size ?? 0) > 0, "sidecar not written");

  // 2. A foreign writer clobbering the file is recovered from the sidecar.
  writeFileSync(json, '{"feature_directory":"specs/078-x"}\n');
  check(quiet(() => gc.featureSourceIssue(TMP)) === "78", "no recovery after clobber");
  check(read().includes('"source_issue"'), "recovery did not heal the file");
  check(read().includes('"feature_directory"'), "recovery dropped feature_directory");

  // 3. Re-linking updates in place instead of appending a second key.
  quiet(() => gc.writeFeatureJson(TMP, "99"));
  check(read().split('"source_issue"').length === 2, "duplicate source_issue key");
  check(gc.featureSourceIssue(TMP) === "99", "re-link did not update");

  // 4. Never linked, never clobbered -> silence, not a phantom issue.
  rmSync(json, { force: true });
  rmSync(sidecar, { force: true });
  check(quiet(() => gc.featureSourceIssue(TMP)) === "", "phantom source_issue");

  console.log("OK: feature.json sidecar recovery");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
