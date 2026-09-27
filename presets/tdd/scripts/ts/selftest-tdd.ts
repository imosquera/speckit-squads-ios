#!/usr/bin/env bun
// tdd preset: selftest-tdd.ts
// Self-contained test for check-tests-accompany.ts. No test framework
// required. The Jev helper (jev.ts) is covered by scripts/selftest-jev.ts.
//
// Usage: bun presets/tdd/scripts/ts/selftest-tdd.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const HERE = import.meta.dir;
const CHECK = join(HERE, "check-tests-accompany.ts");
const WORK = mkdtempSync(join(tmpdir(), "selftest-tdd-"));
let failures = 0;

function report(ok: boolean, name: string, detail: string) {
  if (ok) console.log(`PASS: ${name}`);
  else { console.log(`FAIL: ${name} — ${detail}`); failures++; }
}

async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  return { code: await p.exited, out: out + err };
}

const git = (cwd: string, ...args: string[]) =>
  run(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });

// ------------------------------------------------- check-tests-accompany.ts
// A fresh repo on main, a feature branch, then the files: committed when
// prefixed "c:", untracked otherwise.
async function gate(name: string, want: number, ...files: string[]) {
  const dir = join(WORK, name);
  await run(["git", "init", "-q", "-b", "main", dir]);
  await git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  await git(dir, "checkout", "-q", "-b", "feature");
  for (const f of files) {
    const p = f.replace(/^c:/, "");
    mkdirSync(join(dir, dirname(p)), { recursive: true });
    writeFileSync(join(dir, p), "x\n");
    if (f.startsWith("c:")) { await git(dir, "add", p); await git(dir, "commit", "-q", "-m", p); }
  }
  const r = await run(["bun", CHECK], { cwd: dir });
  report(r.code === want, name, `want rc=${want}, got rc=${r.code}\n    ${r.out.trim()}`);
}

await gate("empty", 4);
await gate("prod-only", 1, "src/app.py");
await gate("prod-committed-only", 1, "c:src/app.ts");
await gate("prod-and-pytest", 0, "src/app.py", "tests/test_app.py");
await gate("prod-and-jest", 0, "c:src/app.ts", "src/app.test.ts");
await gate("prod-and-go", 0, "pkg/x.go", "pkg/x_test.go");
await gate("prod-and-dunder", 0, "lib/a.js", "lib/__tests__/a.js");
await gate("tests-only", 0, "tests/test_new.py");
await gate("docs-only", 0, "README.md", "docs/guide.md");
await gate("config-only", 0, "package.json");
// Spec Kit's installed tooling is vendored: a reinstall alone examines nothing,
// and it never excuses the project's own untested code.
await gate("vendored-only", 4, ".specify/presets/x/scripts/ts/tool.ts");
await gate("vendored-plus-prod", 1, ".specify/presets/x/scripts/ts/tool.ts", "src/app.ts");
{
  // A bad --base is a usage error, never a pass.
  const r = await run(["bun", CHECK, "--base", "no-such-ref"], { cwd: join(WORK, "prod-only") });
  report(r.code === 2, "bad-base", `got rc=${r.code}`);
}

rmSync(WORK, { recursive: true, force: true });
console.log(failures ? `${failures} failure(s)` : "all passed");
process.exit(failures ? 1 : 0);
