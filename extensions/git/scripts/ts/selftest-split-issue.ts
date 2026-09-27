#!/usr/bin/env bun
// git extension: selftest-split-issue.ts
// Self-contained test for split-issue.ts's registry parser (childOf), driven
// through the real script's `--show` path with a stubbed `gh` on PATH.
//
// Usage: bun extensions/git/scripts/ts/selftest-split-issue.ts

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SPLIT = join(import.meta.dir, "split-issue.ts");
if (!existsSync(SPLIT)) { console.error(`error: not found: ${SPLIT}`); process.exit(2); }

const WORK = mkdtempSync(join(tmpdir(), "selftest-split-issue-"));
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));

// `gh issue view <n> --json body --jq .body` — prints whatever the case wrote.
mkdirSync(join(WORK, "bin"));
writeFileSync(join(WORK, "bin/gh"), `#!/usr/bin/env bun
process.stdout.write(require("node:fs").readFileSync(process.env.GH_STUB_BODY));
`);
chmodSync(join(WORK, "bin/gh"), 0o755);
const BODY = join(WORK, "body.md");
const env = { ...process.env, PATH: `${join(WORK, "bin")}:${process.env.PATH}`, GH_STUB_BODY: BODY };

let failures = 0;
function check(name: string, want: string, body: string) {
  writeFileSync(BODY, `${body}\n`);
  const r = Bun.spawnSync([process.execPath, SPLIT, "1", "--show"], { env, stdout: "pipe", stderr: "ignore" });
  const got = r.stdout.toString().replace(/\n+$/, "");
  if (got === want) console.log(`PASS: ${name}`);
  else { console.log(`FAIL: ${name} — want [${want}] got [${got}]`); failures++; }
}

const BEGIN = "<!-- speckit:work-breakdown -->";
const END = "<!-- /speckit:work-breakdown -->";

check("unwrapped bullets (the generator's own output)",
  "frontend 11\nbackend 12\nintegration 13",
  `${BEGIN}
## Work breakdown

- [ ] frontend — mock first, fixtures only: #11
- [ ] backend — no UI: #12
- [ ] integration — wire-up, blocked by the two above: #13
${END}`);

check("wrapped bullet carries its #N on a continuation line",
  "frontend 11\nbackend 12\nintegration 61",
  `${BEGIN}
- [ ] frontend — mock first, fixtures only: #11
- [ ] backend — no UI: #12
- [ ] integration — wire the saved-search UI to the real endpoint and retire
      the fixtures (#61)
${END}`);

check("a passing reference ahead of the child number does not win",
  "backend 12",
  `${BEGIN}
- [ ] backend — supersedes #99, see #98: #12
${END}`);

check("no block at all — nothing is split yet",
  "",
  `Some issue body with a stray bullet:

- [ ] frontend — not in any registry: #11`);

check("text outside the block cannot be folded into a bullet",
  "frontend 11",
  `${BEGIN}
- [ ] frontend — mock first: #11

Unindented prose mentioning #77 ends the bullet.
${END}`);

if (failures === 0) console.log("all cases passed");
else console.error(`${failures} case(s) failed`);
process.exit(failures > 0 ? 1 : 0);
