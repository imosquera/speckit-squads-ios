import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Shared manifest parsing for the repo-root tooling. Deliberately a regex reader,
// not a YAML parser: it only needs `provides.scripts[]` and must stay stdlib-only.

/** The body of `provides:` -> `scripts:` in a manifest, or "" when absent. */
export function scriptsBlock(text: string): string {
  const m = /^provides:[ \t]*$\n([\s\S]*?)(?=^\S)/m.exec(text + "\n\x00");
  if (!m) return "";
  const s = /^ {2}scripts:[ \t]*$\n([\s\S]*?)(?=^ {2}\S|(?![\s\S]))/m.exec(m[1] ?? "");
  return s ? (s[1] ?? "") : "";
}

export const KINDS = [
  ["extensions", "extension.yml"],
  ["presets", "preset.yml"],
] as const;

/** Python-style codepoint comparison, for `sorted()`-equivalent ordering. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Equivalent of `sorted(glob(join(base, kind, "*", manifest)))`: every existing
 * `<base>/<kind>/<id>/<manifest>`, hidden ids skipped, sorted by full path.
 */
export function manifests(base: string, kind: string, manifest: string): { path: string; id: string }[] {
  const dir = base === "" ? kind : join(base, kind);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((id) => !id.startsWith("."))
    .map((id) => ({ path: base === "" ? `${kind}/${id}/${manifest}` : join(base, kind, id, manifest), id }))
    .filter((e) => existsSync(e.path))
    .sort((a, b) => cmp(a.path, b.path));
}

// Equivalent of glob("<kind>/*/commands/*.md"), unsorted, hidden entries skipped.
export function commandFiles(kind: string): string[] {
  const out: string[] = [];
  for (const { path } of manifests("", kind, "commands")) {
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      continue;
    }
    for (const n of names) if (!n.startsWith(".") && n.endsWith(".md")) out.push(`${path}/${n}`);
  }
  return out;
}
