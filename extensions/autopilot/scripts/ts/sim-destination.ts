#!/usr/bin/env bun
// Resolve an `xcodebuild -destination` for an iOS Simulator, so unattended build
// and test gates never depend on whichever device a human last picked in Xcode.
// Usage: sim-destination.ts [--json <file>]      (default: xcrun simctl list devices available -j)
//        sim-destination.ts --selftest
// Prints one line on stdout, `platform=iOS Simulator,id=<udid>`, and a human note on
// stderr naming the device and runtime. Exit 1 when no available iOS simulator exists
// (a Missing-capability stop: an unattended run cannot create one), 2 on usage errors.
//
// Pick order: $SPECKIT_AUTOPILOT_SIM_DESTINATION verbatim when set; else a Booted
// iPhone (already warm, and likely the one a human is watching); else an iPhone on
// the newest installed iOS runtime; else any device on the newest iOS runtime.

import { readFileSync } from "node:fs";

interface Device { udid: string; name: string; state?: string; isAvailable?: boolean }
interface Listing { devices?: Record<string, Device[]> }
export interface Pick { destination: string; note: string }

/** `com.apple.CoreSimulator.SimRuntime.iOS-18-2` → [18, 2]; null for non-iOS runtimes. */
function iosVersion(runtime: string): number[] | null {
  const m = /SimRuntime\.iOS-([0-9-]+)$/.exec(runtime);
  return m ? m[1]!.split("-").map(Number) : null;
}
const cmpVer = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

export function pick(listing: Listing, override?: string): Pick | null {
  if (override) return { destination: override, note: "from SPECKIT_AUTOPILOT_SIM_DESTINATION" };
  const runtimes = Object.entries(listing.devices ?? {})
    .map(([rt, devs]) => ({ ver: iosVersion(rt), devs: devs.filter((d) => d.isAvailable !== false) }))
    .filter((r): r is { ver: number[]; devs: Device[] } => r.ver !== null && r.devs.length > 0)
    .sort((a, b) => cmpVer(b.ver, a.ver)); // newest first
  const iphone = (d: Device) => d.name.startsWith("iPhone");
  const as = (d: Device, ver: number[], why: string): Pick => ({
    destination: `platform=iOS Simulator,id=${d.udid}`,
    note: `${d.name} (iOS ${ver.join(".")}, ${why})`,
  });
  for (const r of runtimes) {
    const d = r.devs.find((x) => x.state === "Booted" && iphone(x));
    if (d) return as(d, r.ver, "booted");
  }
  const newest = runtimes[0];
  if (!newest) return null;
  const d = newest.devs.find(iphone) ?? newest.devs[0]!;
  return as(d, newest.ver, "newest runtime");
}

function selftest(): void {
  let failures = 0;
  const check = (name: string, cond: boolean) => { if (!cond) { console.error(`FAIL: ${name}`); failures++; } };
  const dev = (udid: string, name: string, state = "Shutdown", isAvailable = true): Device => ({ udid, name, state, isAvailable });
  const L = (devices: Record<string, Device[]>): Listing => ({ devices });
  const RT = (v: string) => `com.apple.CoreSimulator.SimRuntime.${v}`;

  check("empty → null", pick(L({})) === null);
  check("watchOS only → null", pick(L({ [RT("watchOS-11-0")]: [dev("W", "Apple Watch")] })) === null);
  check("override wins", pick(L({}), "platform=iOS Simulator,name=iPhone 16")?.destination === "platform=iOS Simulator,name=iPhone 16");
  const two = L({
    [RT("iOS-17-5")]: [dev("OLD", "iPhone 15")],
    [RT("iOS-18-2")]: [dev("IPAD", "iPad Air"), dev("NEW", "iPhone 16")],
  });
  check("newest runtime iPhone", pick(two)?.destination === "platform=iOS Simulator,id=NEW");
  check("note names device", pick(two)?.note.startsWith("iPhone 16 (iOS 18.2") === true);
  const booted = L({
    [RT("iOS-17-5")]: [dev("OLD", "iPhone 15", "Booted")],
    [RT("iOS-18-2")]: [dev("NEW", "iPhone 16")],
  });
  check("booted iPhone wins", pick(booted)?.destination === "platform=iOS Simulator,id=OLD");
  check("unavailable skipped", pick(L({ [RT("iOS-18-2")]: [dev("X", "iPhone 16", "Booted", false), dev("Y", "iPhone 16 Pro")] }))?.destination === "platform=iOS Simulator,id=Y");
  check("iPad-only falls back", pick(L({ [RT("iOS-18-0")]: [dev("P", "iPad Pro")] }))?.destination === "platform=iOS Simulator,id=P");
  check("18.10 > 18.2", pick(L({ [RT("iOS-18-2")]: [dev("A", "iPhone 16")], [RT("iOS-18-10")]: [dev("B", "iPhone 16")] }))?.destination === "platform=iOS Simulator,id=B");

  if (failures) process.exit(1);
  console.log("OK: sim-destination selftest");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--selftest") {
    selftest();
    process.exit(0);
  }
  let raw: string;
  if (args[0] === "--json") {
    if (!args[1]) {
      process.stderr.write("[autopilot] Usage: sim-destination.ts [--json <file>]\n");
      process.exit(2);
    }
    raw = readFileSync(args[1], "utf8");
  } else if (args.length) {
    process.stderr.write("[autopilot] Usage: sim-destination.ts [--json <file>] | --selftest\n");
    process.exit(2);
  } else {
    const override = process.env.SPECKIT_AUTOPILOT_SIM_DESTINATION;
    if (override) {
      console.log(override);
      process.stderr.write("[autopilot] simulator: from SPECKIT_AUTOPILOT_SIM_DESTINATION\n");
      process.exit(0);
    }
    if (!Bun.which("xcrun")) {
      process.stderr.write("[autopilot] Error: xcrun not found — install Xcode and run `xcode-select -s`\n");
      process.exit(1);
    }
    const r = Bun.spawnSync(["xcrun", "simctl", "list", "devices", "available", "-j"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) {
      process.stderr.write(`[autopilot] Error: xcrun simctl failed: ${r.stderr.toString().trim()}\n`);
      process.exit(1);
    }
    raw = r.stdout.toString();
  }
  let listing: Listing;
  try {
    listing = JSON.parse(raw) as Listing;
  } catch (e) {
    process.stderr.write(`[autopilot] Error: unreadable simctl JSON: ${(e as Error).message}\n`);
    process.exit(1);
  }
  const p = pick(listing);
  if (!p) {
    process.stderr.write("[autopilot] Error: no available iOS simulator — install an iOS runtime (Xcode → Settings → Components) or set SPECKIT_AUTOPILOT_SIM_DESTINATION\n");
    process.exit(1);
  }
  console.log(p.destination);
  process.stderr.write(`[autopilot] simulator: ${p.note}\n`);
}
