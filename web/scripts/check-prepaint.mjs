#!/usr/bin/env node
// Safeguard for the settings registry ⇄ pre-paint mirror.
//
// app/layout.tsx restores persisted settings in an inline <script> that runs
// before any module can load — otherwise a setting flashes (resets to default)
// on every hard reload until the settings panel is opened. That script is a
// hand-written mirror of app/lib/settingsRegistry.ts (full codegen was rejected:
// it would rewrite the most timing-sensitive code in the app to dedup the
// low-risk mechanical entries while the drift-prone derived blocks stay literal
// anyway — see plan E-big-2). This guard keeps the mirror honest instead.
//
// It enforces, scoped to the <script> body so comments can't satisfy it:
//   forward — every `prePaint: true` registry key is read by the script
//             (catches "added a setting, forgot the restore" → flash-on-reload)
//   reverse — every key the script reads is a real registry key (any prePaint
//             flag; prePaint:false keys may be read as inputs, e.g. showTimestamps
//             feeds wrap-padding) or an explicit allowlist entry
//             (catches typos / orphaned restores after a rename or removal)
//
// Run: node scripts/check-prepaint.mjs   (exit 1 on any mismatch)
// Wired into `npm run build` so drift fails the build, not a human's memory.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const registry = readFileSync(join(here, "../app/lib/settingsRegistry.ts"), "utf8");
const layout = readFileSync(join(here, "../app/layout.tsx"), "utf8");

// Keys the script legitimately reads that are NOT registry settings.
// chatWidth = the chat resize handle (its own persisted value, not an appearance
// entry). Add here — with a reason — if you ever read another non-registry key.
const ALLOWLIST = new Set([
  "chatWidth",
  // v1 panel keys, read by the pre-paint ONLY as a fallback when the v2 key is
  // absent (first load after the settings v2 update, before settingsMigrate
  // converts this browser's copy). See layout.tsx "LEGACY FALLBACK".
  "theme_chatStart", "theme_chatOpacity", "theme_videoOpacity",
]);

// ── registry: map every entry's ls-key → prePaint flag ─────────────────────────
// Each entry writes `ls: "<key>", ... prePaint: <bool>` in that order.
const registryKeys = new Map();
const reEntry = /ls:\s*"([^"]+)"[\s\S]*?prePaint:\s*(true|false)/g;
for (let m; (m = reEntry.exec(registry)) !== null; ) registryKeys.set(m[1], m[2] === "true");

// ── pre-paint script body: isolate it so comments elsewhere don't count ────────
const start = layout.indexOf("__html:");
const end = layout.indexOf("`}}", start);
if (start === -1 || end === -1) {
  console.error("✗ could not locate the pre-paint <script> body in app/layout.tsx");
  process.exit(1);
}
const script = layout.slice(start, end);

// Every localStorage key the script reads.
const referenced = new Set();
const reGet = /(?:localStorage\.)?getItem\(\s*['"]([^'"]+)['"]/g;
for (let m; (m = reGet.exec(script)) !== null; ) referenced.add(m[1]);

// ── forward: prePaint:true must be restored ────────────────────────────────────
const missing = [];
for (const [key, prePaint] of registryKeys) {
  if (prePaint && !referenced.has(key)) missing.push(key);
}

// ── reverse: every restore must map to a known key ─────────────────────────────
const orphaned = [];
for (const key of referenced) {
  if (!registryKeys.has(key) && !ALLOWLIST.has(key)) orphaned.push(key);
}

let failed = false;
if (missing.length) {
  failed = true;
  console.error("✗ pre-paint script is MISSING these prePaint:true settings (they will flash on reload):\n  " + missing.join("\n  "));
  console.error("  → add a matching restore to the inline <script> in app/layout.tsx.\n");
}
if (orphaned.length) {
  failed = true;
  console.error("✗ pre-paint script reads UNKNOWN keys (renamed/removed setting, or a typo):\n  " + orphaned.join("\n  "));
  console.error("  → fix the key, or add it to ALLOWLIST in this script with a reason.\n");
}
if (failed) process.exit(1);

console.log(`✓ pre-paint mirror in sync: ${[...registryKeys.values()].filter(Boolean).length} prePaint keys restored, ${referenced.size} reads all resolve`);
