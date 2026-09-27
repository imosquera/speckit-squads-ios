#!/usr/bin/env bun
/**
 * Script-path check, run by check-cli-usage.ts from the repo root (paths are
 * cwd-relative). See the numbered rules in check-cli-usage.ts. Every script this
 * repo ships is `scripts/ts/*.ts`; any reference to a `scripts/bash/*.sh` of ours
 * fails. Core Spec Kit's own flat `scripts/bash/` (CORE_BASH) is upstream and allowed.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KINDS, cmp, commandFiles, manifests, scriptsBlock } from "./manifest.ts";

const problems: string[] = [];
const declared = new Map<string, Set<string>>();

// Core Spec Kit's scripts (`.specify/scripts/bash/`, or bare `scripts/bash/` in a
// preset's frontmatter). Not ours, so not ported.
const CORE_BASH = new Set(["check-prerequisites.sh", "common.sh", "create-new-feature.ts", "setup-plan.sh", "setup-tasks.sh"]);
const BASH_RETIRED = "bash is retired here; use scripts/ts/<name>.ts run with bun";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** File lines as Python's universal-newline iteration sees them. */
function lines(path: string): string[] {
  const out = readFileSync(path, "utf8").split(/\r\n|\r|\n/);
  if (out.at(-1) === "") out.pop();
  return out;
}

for (const [kind, manifest] of KINDS) {
  for (const { path, id } of manifests("", kind, manifest)) {
    const block = scriptsBlock(readFileSync(path, "utf8"));
    const files = new Set<string>();
    for (const m of block.matchAll(/^\s*file:\s*["']?([^"'\s]+)/gm)) if (m[1]) files.add(m[1]);
    declared.set(`${kind}/${id}`, files);
    for (const f of [...files].sort(cmp)) {
      if (f.endsWith(".sh")) problems.push(`${path}: declares a bash script: ${f} — ${BASH_RETIRED}`);
      else if (!isFile(join(kind, id, f))) problems.push(`${path}: declared script does not exist: ${f}`);
    }
  }
}

const REF =
  /\.specify\/(extensions|presets)\/([A-Za-z0-9_-]+)\/(scripts\/[A-Za-z0-9_./-]+)|\.specify\/scripts\/(bash|powershell|python)\/([A-Za-z0-9_./-]+)/g;

const cmdFiles = [...commandFiles("extensions"), ...commandFiles("presets")].sort(cmp);
for (const cf of cmdFiles) {
  lines(cf).forEach((line, i) => {
    const lineno = i + 1;
    for (const m of line.matchAll(REF)) {
      const [whole, kind, oid, rel, tree, tail] = m;
      if (rel?.endsWith(".sh")) continue; // the bash rule below reports it
      if (kind && oid && rel) {
        const decl = declared.get(`${kind}/${oid}`);
        if (!isFile(join(kind, oid, rel))) {
          problems.push(`${cf}:${lineno}: path does not exist: ${whole}`);
        } else if (!decl) {
          problems.push(`${cf}:${lineno}: unknown ${kind.slice(0, -1)} id '${oid}'`);
        } else if (!decl.has(rel)) {
          problems.push(
            `${cf}:${lineno}: ${rel} is not declared in ${kind}/${oid}/` +
              `${kind === "extensions" ? "extension.yml" : "preset.yml"} ` +
              `(add it under provides.scripts)`,
          );
        }
      } else if (tree && tail && tail.includes("/")) {
        // Core tree: flat by construction. A subdirectory here is the
        // `.specify/scripts/bash/<extension-id>/` mistake.
        problems.push(
          `${cf}:${lineno}: \`.specify/scripts/${tree}/\` is the FLAT core ` +
            `tree — it has no '${tail.split("/")[0]}/' subdirectory. Extension ` +
            `scripts live at .specify/extensions/<id>/scripts/${tree}/`,
        );
      }
    }
  });
}

// Any scripts/bash/*.sh reference is ours (and retired) unless it names a core
// script, either in the flat core tree or bare (a frontmatter `sh:` line).
const BASH_REF = /scripts\/bash\/([A-Za-z0-9_./-]*\.sh)\b/g;
// Frontmatter `sh:`/`ps:` value, optionally run via bun; relative to the item root.
const FM_SCRIPT = /^\s*(?:sh|ps):\s*(?:bun\s+)?(scripts\/[A-Za-z0-9_./-]+)/;
for (const cf of cmdFiles) {
  const [kind, id] = cf.split("/") as [string, string];
  const all = lines(cf);
  const fmEnd = all[0]?.trim() === "---" ? all.findIndex((l, i) => i > 0 && l.trim() === "---") : -1;
  all.forEach((line, i) => {
    for (const m of line.matchAll(BASH_REF)) {
      const name = m[1] ?? "";
      const before = line.slice(0, m.index);
      const core = CORE_BASH.has(name) && (before.endsWith(".specify/") || !/[A-Za-z0-9_./$}-]$/.test(before));
      if (!core) problems.push(`${cf}:${i + 1}: references bash script ${m[0]} — ${BASH_RETIRED}`);
    }
    const fm = i < fmEnd ? FM_SCRIPT.exec(line) : null;
    const rel = fm?.[1];
    if (!rel || rel.endsWith(".sh") || rel.endsWith(".ps1")) return; // bash covered above; ps1 is core
    if (!isFile(join(kind, id, rel))) problems.push(`${cf}:${i + 1}: frontmatter script does not exist: ${kind}/${id}/${rel}`);
    else if (!declared.get(`${kind}/${id}`)?.has(rel))
      problems.push(`${cf}:${i + 1}: ${rel} is not declared in ${kind}/${id}/${kind === "extensions" ? "extension.yml" : "preset.yml"} (add it under provides.scripts)`);
  });
}

const BARE_CPD =/\$(?:CLAUDE_PROJECT_DIR\b|\{CLAUDE_PROJECT_DIR\})/;
for (const cf of cmdFiles) {
  let inBash = false;
  lines(cf).forEach((line, i) => {
    const stripped = line.trim();
    if (stripped.startsWith("```")) {
      inBash = !inBash ? stripped.slice(3).trim() === "bash" : false;
      return;
    }
    if (inBash && BARE_CPD.test(line)) {
      problems.push(
        `${cf}:${i + 1}: bare $CLAUDE_PROJECT_DIR in a bash block — it is empty ` +
          `in an interactive session (issue #59). Use ` +
          `PROJECT_DIR="\${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" ` +
          `in this block and reference $PROJECT_DIR`,
      );
    }
  });
}

// Each item that asks Jev ships its own copy of scripts/jev.ts (items install
// independently); a copy that drifts from the canonical one is a second place
// for a question to change unreviewed.
const jev = readFileSync("scripts/jev.ts", "utf8");
for (const copy of new Bun.Glob("{extensions,presets}/*/scripts/ts/jev.ts").scanSync(".")) {
  if (readFileSync(copy, "utf8") !== jev) problems.push(`${copy}: differs from scripts/jev.ts — cp scripts/jev.ts ${copy}`);
}

for (const p of problems) console.error(p);
if (problems.length > 0) {
  console.error("error: command files reference script paths that do not resolve");
  process.exit(1);
}
let total = 0;
for (const v of declared.values()) total += v.size;
console.log(`script path check: ok (${total} declared scripts, ${cmdFiles.length} command files)`);
