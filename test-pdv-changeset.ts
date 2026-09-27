#!/usr/bin/env bun
// Check for parse_dont_validate.ts, the Swift parse-don't-validate gate:
//   1. the scan anchors at the git worktree root, even from a subdirectory;
//   2. --new-only subtracts findings that already reproduce on the base ref;
//   3. a scan that examined ZERO files never exits like a clean pass (issue #50):
//      bad flag, empty path, non-repo cwd and empty change set each exit non-zero;
//   4. vendored `.specify/` and `Pods/` code is never reported as the project's;
//   5. the Swift scanner reports exact rule/line findings for every rule, ignores
//      comments and string literals (but not interpolations), honours waivers and
//      parser scopes, and fails loudly on source it cannot lex.
// Usage: bun test-pdv-changeset.ts   (exit 0 pass, 1 fail)

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = import.meta.dir;
const SCRIPT = join(ROOT, "presets/parse-dont-validate/scripts/ts/parse_dont_validate.ts");
const TMP = mkdtempSync(join(tmpdir(), "test-pdv-changeset-"));
const SWF = mkdtempSync(join(tmpdir(), "test-pdv-swift-"));
process.on("exit", () => {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(SWF, { recursive: true, force: true });
});
let fail = 0;

const indent = (s: string) => s.replace(/\n+$/, "").split("\n").map((l) => `       ${l}`).join("\n");
const bad = (msg: string, extra?: string) => {
  console.log(`  FAIL ${msg}`);
  if (extra !== undefined) console.log(indent(extra));
  fail = 1;
};
function check(name: string, want: number, got: number, extra: string) {
  if (want === got) console.log(`  ok   ${name}`);
  else bad(`${name} (expected exit ${want}, got ${got})`, extra);
}

/** Run a command; stdout and stderr together, as `2>&1` gave the bash test. */
function run(cmd: string[], cwd = TMP) {
  const p = Bun.spawnSync(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { out: p.stdout.toString() + p.stderr.toString(), st: p.exitCode ?? -1 };
}
const pdv = (args: string[], cwd = TMP) => run(["bun", SCRIPT, ...args], cwd);
const git = (...args: string[]) => {
  const r = run(["git", ...args]);
  if (r.st !== 0) throw new Error(`git ${args.join(" ")} failed:\n${r.out}`);
};
const write = (rel: string, text: string) => {
  mkdirSync(join(TMP, rel, ".."), { recursive: true });
  writeFileSync(join(TMP, rel), text);
};

git("init", "-q", "-b", "main", ".");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
// pre-existing finding on main
write("Pkg/Old.swift", "func handle(_ x: Any) {}\n");
git("add", "-A");
git("commit", "-qm", "base");

git("checkout", "-qb", "feature");
// new finding, committed, in a subdirectory
write("App/Sources/New.swift", "func added(_ y: Any) {}\n");
// and a new finding touching the pre-existing file
appendFileSync(join(TMP, "Pkg/Old.swift"), "func later(_ z: Any) {}\n");
// Spec Kit's installed tooling and CocoaPods are vendored, never the project's findings
write(".specify/presets/x/Tool.swift", "let v: Any = 1\n");
write("Pods/Lib/Lib.swift", "let v: Any = 1\n");
git("add", "-A");
git("commit", "-qm", "work");

console.log("test-pdv-changeset");
const SUB = join(TMP, "App");

let { out, st } = pdv(["scan", "--base", "main"], SUB);
check("scan from a subdirectory sees the whole change set", 1, st, out);
for (const f of ["App/Sources/New.swift", "Pkg/Old.swift"]) if (!out.includes(f)) bad(`missing ${f} in scan output`, out);
if (out.includes(".specify/")) bad("scan reported vendored .specify/ tooling", out);
if (out.includes("Pods/")) bad("scan reported vendored Pods/ code", out);

({ out, st } = pdv(["scan", "--base", "main", "--new-only"], SUB));
check("--new-only still fails on findings this branch added", 1, st, out);
if (!out.includes("func added")) bad("--new-only dropped a new finding");
if (out.includes("func handle")) bad("--new-only kept a pre-existing finding");
if (!out.includes("func later")) bad("--new-only dropped a new finding in a pre-existing file");
if (!out.includes("ignored 1 pre-existing")) bad("no pre-existing count reported", out);

// a branch that only shifts a pre-existing finding down: still reported by
// scan, still clean under --new-only (fingerprints ignore line numbers).
git("checkout", "-q", "main");
git("checkout", "-qb", "shuffle");
const old = readFileSync(join(TMP, "Pkg/Old.swift"), "utf8");
writeFileSync(join(TMP, "Pkg/Old.swift"), `// a comment\n${old.replace(/\n+$/, "")}`);
git("commit", "-qam", "shuffle");
({ out, st } = pdv(["scan", "--base", "main"]));
check("plain scan reports the shifted pre-existing finding", 1, st, out);
({ out, st } = pdv(["scan", "--base", "main", "--new-only"]));
check("--new-only is clean when the branch only moved existing code", 0, st, out);

// --- a scan that examined nothing is never a clean pass (issue #50)
git("checkout", "-q", "main");
git("checkout", "-qb", "empty");
write("docs/readme.md", "hello\n");
write("tools/gen.ts", "export const a: any = 1;\n");
git("add", "-A");
git("commit", "-qm", "docs");

({ out, st } = pdv(["scan", "--base", "main", "--nwe-only"]));
check("a typo'd flag is a usage error, not a clean scan", 2, st, out);
if (!out.includes("unknown option")) bad("typo'd flag not named");

({ out, st } = pdv(["scan", "--base"]));
check("--base with no ref is a usage error", 2, st, out);

// `--base --new-only` used to consume the flag as the ref and exit 4.
({ out, st } = pdv(["scan", "--base", "--new-only"]));
check("--base followed by another option is a usage error", 2, st, out);
if (!out.includes("needs a ref argument")) bad("--base misuse not named", out);

({ out, st } = pdv(["scan", "--base=", "--new-only"]));
check("--base= with an empty ref is a usage error", 2, st, out);

({ out, st } = pdv(["scan", "NoSuchFile.swift"]));
check("paths that resolve to nothing are a hard error", 3, st, out);

({ out, st } = pdv(["scan", "tools/gen.ts"]));
check("a non-Swift path is not scanned (TypeScript is out of scope)", 3, st, out);

({ out, st } = pdv(["scan"], "/"));
check("no change set outside a git worktree is a hard error", 3, st, out);

({ out, st } = pdv(["scan", "--base", "main"]));
check("a change set with no Swift exits 4, not 0", 4, st, out);
if (!out.includes("not a clean scan")) bad("empty change set not called out", out);

// --- the Swift scanner: one case per rule, exact rule/line set
console.log("Swift scanner");
const SWIFT_FIXTURE = `import Foundation
// comment: let a: Any = 1; x as! T; try! f(); JSONSerialization
/* block /* nested as! */ try! Any */
protocol Delegate: AnyObject {}
final class Box<T: AnyObject> { weak var d: (Delegate & AnyObject)? }
func handle(_ payload: [String: Any]) -> AnyObject? { nil }
let s = "as! try! Any JSONSerialization \\(try! load())"
let r = #"raw "quoted" as! \\(x) Any"#
let obj = try JSONSerialization.jsonObject(with: data)
let plist = try PropertyListSerialization.propertyList(from: data, format: nil)
let bag = try JSONDecoder().decode([String: String].self, from: data)
let user = try JSONDecoder().decode(User.self, from: data)
func isValidEmail(_ s: String) -> Bool { s.contains("@") }
func validate() throws -> Bool { true }
func checkValidAge<T>(_ v: T) async -> Swift.Bool { true }
func isValidMaybe() -> Bool? { nil }
func isEnabled() -> Bool { true }
let e = thing as! Email
let f = thing as? Email
let m = """
  multi as! try! Any
  \\(value as! Int)
  """
let w = thing as! Email // parse-dont-validate: allow PDV004 (boundary)
// parse-dont-validate: allow PDV005 (test fixture)
let t = try! loadFixture()
let u = try! load()
struct User: Decodable {
  let name: String
  init(from decoder: Decoder) throws {
    let json = try JSONSerialization.jsonObject(with: Data()) as! [String: Any]
    name = json["n"] as! String
    let bad = try! other()
  }
}
struct Email {
  let raw: String
  init?(parsing s: Any) { raw = s as! String }
  func isValidX() -> Bool { true }
}
enum UserParser { static func run(_ d: Data) -> Any { d as! Any } }
`;
// Outside parser scopes every rule fires; inside (Decodable body, init(parsing:)
// params + body, *Parser* type) only PDV003 (validators) and PDV005 (try!) still do.
const COMMON = "7:PDV005 13:PDV003 14:PDV003 15:PDV003 27:PDV005 33:PDV005 39:PDV003";
const SWIFT_WANTS: [string, string][] = [
  ["Service.swift", "6:PDV001 7:PDV005 9:PDV002 10:PDV002 11:PDV002 " +
    "13:PDV003 14:PDV003 15:PDV003 18:PDV004 22:PDV004 27:PDV005 33:PDV005 39:PDV003"],
  // a parser-named file is a parser scope throughout
  ["UserParser.swift", COMMON],
];
writeFileSync(join(SWF, "Service.swift"), SWIFT_FIXTURE);
writeFileSync(join(SWF, "UserParser.swift"), SWIFT_FIXTURE);
for (const [f, want] of SWIFT_WANTS) {
  const got = pdv(["scan", f], SWF)
    .out.split("\n")
    .flatMap((l) => {
      const m = /^[^ ]+\.swift:([0-9]+): (PDV[0-9]+)/.exec(l);
      return m ? [`${m[1]}:${m[2]}`] : [];
    })
    .join(" ");
  if (got === want) console.log(`  ok   ${f} findings match the expected rule/line set`);
  else bad(`${f} findings`, `want: ${want}\ngot:  ${got}`);
}

// a well-formed parser module is clean: failable/throwing inits and Decodable
// return domain types; untrusted Data and [String: Any] stay inside the parser.
writeFileSync(join(SWF, "Profile.swift"), `import Foundation

struct Email: Hashable {
  let raw: String
  init(parsing raw: String) throws {
    guard raw.contains("@") else { throw ParseError.invalidEmail(raw) }
    self.raw = raw
  }
}

struct UserID: RawRepresentable, Hashable { let rawValue: String }

struct Profile: Decodable {
  let id: UserID
  let email: Email
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = UserID(rawValue: try c.decode(String.self, forKey: .id))
    email = try Email(parsing: try c.decode(String.self, forKey: .email))
  }
  private enum CodingKeys: String, CodingKey { case id, email }
}

enum LegacyProfileParser {
  static func parse(_ data: Data) throws -> Profile {
    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let email = json["email"] as? String else { throw ParseError.malformed }
    _ = json as! [String: Any]
    return try JSONDecoder().decode(Profile.self, from: data)
  }
}

final class ProfileStore {
  func load(_ data: Data) throws -> Profile { try LegacyProfileParser.parse(data) }
}
`);
({ out, st } = pdv(["scan", "Profile.swift"], SWF));
check("a clean parser module (Decodable + init(parsing:) + *Parser* type) passes", 0, st, out);

writeFileSync(join(SWF, "Broken.swift"), 'let a = "never closed\nlet b = 1\n');
({ out, st } = pdv(["scan", "Broken.swift"], SWF));
check("an unterminated string is a scan failure, not a clean file", 3, st, out);
if (!out.includes("cannot lex Swift source")) bad("lex failure not named", out);
writeFileSync(join(SWF, "Unbalanced.swift"), "struct A {\n  func f() {\n}\n");
({ out, st } = pdv(["scan", "Unbalanced.swift"], SWF));
check("unbalanced braces are a scan failure, not a clean file", 3, st, out);

// --- the prompt's exit contract is internally consistent
// Every place that states the exit contract must carry the verified exit-4
// carve-out, or a docs-only run cannot satisfy all instructions at once.
const cmdLines = readFileSync(join(ROOT, "presets/parse-dont-validate/commands/speckit.implement.md"), "utf8").split("\n");
const has = (re: RegExp) => cmdLines.some((l) => re.test(l));
const cmdRule = (name: string, re: string) => {
  if (has(new RegExp(re, "i"))) console.log(`  ok   ${name}`);
  else bad(`${name} (no line matching /${re}/ in speckit.implement.md)`);
};
if (has(/Re-run `scan --new-only` until it exits zero\./)) bad("the rerun loop still demands exit zero with no exit-4 carve-out");
else console.log("  ok   the rerun loop admits the verified exit-4 case");
cmdRule("the rerun loop names exit 4", "exits zero, or exits .4.");
cmdRule("the failure policy names the exit-4 exception", "exit-.4. exception");
if (has(/^- Whether the parse-don.t-validate scan ran and that it exited zero\.$/))
  bad("the completion report still requires reporting a zero exit only");
else console.log("  ok   the completion report admits the verified exit-4 case");

console.log(fail === 0 ? "test-pdv-changeset: PASS" : "test-pdv-changeset: FAIL");
process.exit(fail);
