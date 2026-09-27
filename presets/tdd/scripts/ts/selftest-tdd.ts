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
await gate("prod-only", 1, "Sources/Core/Parser.swift");
await gate("prod-committed-only", 1, "c:MyApp/Views/HomeView.swift");
await gate("objc-only", 1, "MyApp/Legacy/Bridge.m", "MyApp/Legacy/Bridge.h");
await gate("metal-only", 1, "MyApp/Shaders/Blur.metal");
// SPM: Sources/ is production, Tests/<Target>Tests/ is the test target.
await gate("spm-prod-and-test", 0, "Sources/Core/Parser.swift", "Tests/CoreTests/ParserTests.swift");
// Xcode: <Target>Tests/ and <Target>UITests/ target directories.
await gate("xcode-unit-tests", 0, "c:MyApp/Model/Cart.swift", "MyAppTests/CartTests.swift");
await gate("xcode-ui-tests", 0, "MyApp/Views/HomeView.swift", "MyAppUITests/HomeFlow.swift");
// Named *Test.swift / *Tests.swift anywhere counts, as does an ObjC *Tests.m.
await gate("swift-test-name", 0, "Sources/Core/Cart.swift", "Sources/Core/CartTest.swift");
await gate("objc-tests-name", 0, "MyApp/Legacy/Bridge.m", "Legacy/BridgeTests.m");
await gate("generic-tests-dir", 0, "Sources/Core/Cart.swift", "tests/cart_helpers.swift");
await gate("tests-only", 0, "Tests/CoreTests/NewTests.swift");
await gate("docs-only", 0, "README.md", "docs/guide.md");
// Non-code: resources, project files, lockfiles and the package manifest.
await gate("resources-only", 0, "MyApp/Assets.xcassets/AppIcon.appiconset/Contents.json",
  "MyApp/Base.lproj/Main.storyboard", "MyApp/Cell.xib", "MyApp/Info.plist",
  "MyApp/Localizable.xcstrings", "Config/Debug.xcconfig");
await gate("project-files-only", 0, "MyApp.xcodeproj/project.pbxproj",
  "MyApp.xcworkspace/xcshareddata/swiftpm/Package.resolved", "Package.resolved");
await gate("manifest-only", 0, "Package.swift", "Package@swift-5.9.swift");
// Dependency and build trees are vendored, like .specify/.
await gate("pods-only", 4, "Pods/Alamofire/Source/Session.swift");
await gate("pods-plus-prod", 1, "Pods/Alamofire/Source/Session.swift", "MyApp/App.swift");
// A test target *directory* name must end in Tests: a prod folder merely
// containing "Test" is still production.
await gate("testkit-is-prod", 1, "Sources/TestKit/Fixtures.swift");
// Spec Kit's installed tooling is vendored: a reinstall alone examines nothing,
// and it never excuses the project's own untested code.
await gate("vendored-only", 4, ".specify/presets/x/scripts/ts/tool.ts");
await gate("vendored-plus-prod", 1, ".specify/presets/x/scripts/ts/tool.ts", "MyApp/App.swift");
{
  // A bad --base is a usage error, never a pass.
  const r = await run(["bun", CHECK, "--base", "no-such-ref"], { cwd: join(WORK, "prod-only") });
  report(r.code === 2, "bad-base", `got rc=${r.code}`);
}

rmSync(WORK, { recursive: true, force: true });
console.log(failures ? `${failures} failure(s)` : "all passed");
process.exit(failures ? 1 : 0);
