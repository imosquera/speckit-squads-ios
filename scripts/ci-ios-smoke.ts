#!/usr/bin/env bun
// Real-Xcode smoke test for the paths the unit tests only exercise with fake binaries:
// sim-destination.ts against a live `simctl`, check-target-repo.ts --kind, git's
// install-deps.ts running `xcodebuild -resolvePackageDependencies -project` and
// `swift package resolve` in a fresh worktree, and xcodebuild build/test on the
// resolved Simulator. Needs full Xcode, a Simulator runtime, and xcodegen on PATH
// (brew install xcodegen). CI runs it on a macOS runner; locally: bun scripts/ci-ios-smoke.ts
//
// ponytail: one app fixture (xcodeproj + one SPM dependency) and one package fixture;
// add a CocoaPods/workspace fixture when a bug shows up there.

import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const AP = join(REPO, "extensions/autopilot/scripts/ts");
const INSTALL_DEPS = join(REPO, "extensions/git/scripts/ts/install-deps.ts");
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "ios-smoke-")));

function sh(cwd: string, cmd: string[]): string {
  console.log(`$ (${cwd.replace(ROOT, "$ROOT")}) ${cmd.join(" ")}`);
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) {
    console.error(out.split("\n").slice(-40).join("\n"));
    throw new Error(`exit ${r.exitCode}: ${cmd.join(" ")}`);
  }
  return out;
}
function expect(cond: boolean, msg: string, detail = ""): void {
  if (!cond) throw new Error(`FAIL: ${msg}\n${detail}`);
  console.log(`  ok   ${msg}`);
}
const write = (p: string, s: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, s);
};
function gitRepo(dir: string): void {
  sh(dir, ["git", "init", "-q", "-b", "main"]);
  sh(dir, ["git", "-c", "user.name=ci", "-c", "user.email=ci@example.com", "add", "-A"]);
  sh(dir, ["git", "-c", "user.name=ci", "-c", "user.email=ci@example.com", "commit", "-qm", "fixture"]);
}

// 1. Simulator destination from the live simctl.
const dest = sh(REPO, ["bun", join(AP, "sim-destination.ts")]).split("\n").find((l) => l.startsWith("platform=")) ?? "";
expect(/^platform=iOS Simulator,id=[0-9A-F-]{36}$/.test(dest), `sim-destination -> ${dest}`);

// 2. App fixture: xcodegen project with one SPM dependency.
const app = join(ROOT, "App");
write(join(app, "project.yml"), `name: Smoke
options: { bundleIdPrefix: ci.smoke, deploymentTarget: { iOS: "17.0" } }
packages:
  Algorithms: { url: https://github.com/apple/swift-algorithms, from: "1.2.0" }
targets:
  Smoke:
    type: application
    platform: iOS
    sources: [Sources]
    dependencies: [{ package: Algorithms }]
    settings: { GENERATE_INFOPLIST_FILE: YES, CODE_SIGNING_ALLOWED: NO }
  SmokeTests:
    type: bundle.unit-test
    platform: iOS
    sources: [Tests]
    dependencies: [{ target: Smoke }]
    settings: { GENERATE_INFOPLIST_FILE: YES, CODE_SIGNING_ALLOWED: NO }
schemes:
  Smoke:
    build: { targets: { Smoke: all } }
    test: { targets: [SmokeTests] }
`);
write(join(app, "Sources/App.swift"), `import SwiftUI
import Algorithms

func chunked(_ xs: [Int]) -> [[Int]] { xs.chunks(ofCount: 2).map(Array.init) }

@main struct SmokeApp: App {
  var body: some Scene { WindowGroup { Text("smoke") } }
}
`);
write(join(app, "Tests/SmokeTests.swift"), `import XCTest
@testable import Smoke

final class SmokeTests: XCTestCase {
  func testChunked() { XCTAssertEqual(chunked([1, 2, 3]), [[1, 2], [3]]) }
}
`);
sh(app, ["xcodegen", "generate", "--quiet"]);
sh(app, ["xcodebuild", "-resolvePackageDependencies", "-project", "Smoke.xcodeproj"]); // writes the tracked Package.resolved
gitRepo(app);

const kind = sh(app, ["bun", join(AP, "check-target-repo.ts"), "--repo-root", app, "--kind"]);
expect(/KIND: project .*Smoke\.xcodeproj/.test(kind), "check-target-repo --kind -> project", kind);

// 3. install-deps in a fresh worktree must resolve the app's packages for real.
const appWt = join(ROOT, "App-wt");
sh(app, ["git", "worktree", "add", "-q", "-b", "feat", appWt]);
const deps = sh(appWt, ["bun", INSTALL_DEPS, appWt]);
expect(/installed:/.test(deps) && !/FAILED/.test(deps), "install-deps resolves the xcodeproj's packages", deps);

// 4. Build and test in the worktree on the resolved Simulator.
sh(appWt, ["xcodebuild", "test", "-project", "Smoke.xcodeproj", "-scheme", "Smoke", "-destination", dest, "-quiet"]);
expect(true, "xcodebuild test on the Simulator");

// 5. Package fixture: kind + install-deps' `swift package resolve` + swift test.
const pkg = join(ROOT, "Pkg");
mkdirSync(pkg);
sh(pkg, ["swift", "package", "init", "--type", "library", "--name", "Pkg"]);
sh(pkg, ["swift", "build"]); // base .build/ is install-deps' signal for an untracked Package.resolved
gitRepo(pkg);
const pkind = sh(pkg, ["bun", join(AP, "check-target-repo.ts"), "--repo-root", pkg, "--kind"]);
expect(/KIND: package/.test(pkind), "check-target-repo --kind -> package", pkind);
const pkgWt = join(ROOT, "Pkg-wt");
sh(pkg, ["git", "worktree", "add", "-q", "-b", "feat", pkgWt]);
const pdeps = sh(pkgWt, ["bun", INSTALL_DEPS, pkgWt]);
expect(/installed:/.test(pdeps) && !/FAILED/.test(pdeps), "install-deps runs swift package resolve", pdeps);
sh(pkgWt, ["swift", "test"]);
expect(true, "swift test");

console.log("ios smoke: all passed");
