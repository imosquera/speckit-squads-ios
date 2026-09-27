#!/usr/bin/env bun
/**
 * Print the real path of the directory that decides which repo `<path>` is in.
 *
 * Usage: resolve-path.ts <path>
 *
 * Expands `~`/`~user`, makes the path absolute, and for a path that does not
 * exist yet (an issue may ask for a NEW file) walks up to its deepest existing
 * ancestor — the directory the file would be created in — before resolving
 * symlinks. `check-target-repo.ts` then asks git which repo that directory is in.
 *
 * Ported from the inline Python in `check-target-repo.ts`
 * (`expanduser` → `abspath` → walk up while missing → `realpath`); the output is
 * the same, including POSIX `normpath`'s keep-exactly-two-leading-slashes rule.
 */
import { existsSync, lstatSync, readlinkSync } from "node:fs";

/** `os.path.expanduser`. */
function expanduser(path: string): string {
  if (!path.startsWith("~")) return path;
  let i = path.indexOf("/", 1);
  if (i < 0) i = path.length;
  let home: string;
  if (i === 1) {
    const env = process.env.HOME;
    if (env === undefined) {
      const r = Bun.spawnSync(["/bin/sh", "-c", 'eval "printf %s ~$(id -un)"'], { stdout: "pipe", stderr: "ignore" });
      home = r.stdout.toString();
      if (r.exitCode !== 0 || !home || home.startsWith("~")) return path;
    } else {
      home = env;
    }
  } else {
    const name = path.slice(1, i);
    // Looked up the way the shell's own tilde expansion does (getpwnam), and
    // only for a plausible account name — the name is interpolated into `sh`.
    if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(name)) return path;
    const r = Bun.spawnSync(["/bin/sh", "-c", `printf %s ~${name}`], { stdout: "pipe", stderr: "ignore" });
    home = r.stdout.toString();
    if (r.exitCode !== 0 || home === `~${name}`) return path;
  }
  home = home.replace(/\/+$/, "");
  return home + path.slice(i) || "/";
}

/** `posixpath.normpath`. */
function normpath(path: string): string {
  if (!path) return ".";
  let initial = path.startsWith("/") ? 1 : 0;
  if (initial && path.startsWith("//") && !path.startsWith("///")) initial = 2;
  const out: string[] = [];
  for (const comp of path.split("/")) {
    if (!comp || comp === ".") continue;
    if (comp !== ".." || (!initial && !out.length) || (out.length && out.at(-1) === "..")) out.push(comp);
    else if (out.length) out.pop();
  }
  const joined = "/".repeat(initial) + out.join("/");
  return joined || ".";
}

/** `posixpath.dirname`. */
function dirname(p: string): string {
  const i = p.lastIndexOf("/") + 1;
  let head = p.slice(0, i);
  if (head && head !== "/".repeat(head.length)) head = head.replace(/\/+$/, "");
  return head;
}

function exists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/**
 * `posixpath.realpath` (non-strict), component by component with lstat/readlink.
 * Not `fs.realpathSync`: that asks the OS for the canonical path, which on macOS
 * rewrites the case of every component and fails outright on a directory the
 * caller cannot open (`/var/root`) — neither of which Python did.
 */
function realpath(filename: string): string {
  const rest: (string | null)[] = filename.split("/").reverse();
  let partCount = rest.length;
  let path = filename.startsWith("/") ? "/" : process.cwd();
  const seen = new Map<string, string | null>();
  while (partCount) {
    const name = rest.pop();
    if (name === null) {
      // resolved symlink target
      seen.set(rest.pop() as string, path);
      continue;
    }
    partCount--;
    if (!name || name === ".") continue;
    if (name === "..") {
      path = path.slice(0, path.lastIndexOf("/")) || "/";
      continue;
    }
    const newpath = path === "/" ? path + name : path + "/" + name;
    let target: string;
    try {
      if (!lstatSync(newpath).isSymbolicLink()) {
        path = newpath;
        continue;
      }
      if (seen.has(newpath)) {
        const cached = seen.get(newpath);
        // A seen-but-unresolved link is a loop; non-strict keeps the link path.
        path = cached ?? newpath;
        continue;
      }
      target = readlinkSync(newpath);
    } catch {
      path = newpath;
      continue;
    }
    if (target.startsWith("/")) path = "/";
    seen.set(newpath, null);
    rest.push(newpath, null);
    const parts = target.split("/").reverse();
    rest.push(...parts);
    partCount += parts.length;
  }
  return path;
}

const arg = process.argv[2];
if (arg === undefined) {
  process.stderr.write("usage: resolve-path.ts <path>\n");
  process.exit(2);
}

let p = expanduser(arg);
p = normpath(p.startsWith("/") ? p : process.cwd() + "/" + p);
while (!exists(p) && p !== dirname(p)) p = dirname(p);
process.stdout.write(realpath(p) + "\n");
