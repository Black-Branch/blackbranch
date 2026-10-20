#!/usr/bin/env node
// Generate each package's copy of the instance settings schema, or check that none has drifted.
//
//   node tools/gen-instance-schema.mjs            write all three copies
//   node tools/gen-instance-schema.mjs --check P  exit 1 if package P's copy differs (check:all)
//
// WHY GENERATED COPIES. The schema is ONE file (config/instance-schema.mjs), but stream-api
// deploys `*.js` from its own folder and stream-ingest is rsynced whole, so a module outside
// them does not exist on the runtime box — a shared `require('../config/…')` resolves in the
// repo and dies in production on whichever service deployed first (the reason
// stream-api/cross-package-drift.test.js exists). So each package carries a generated copy,
// and this check makes "the copy is the schema" a build fact rather than a hope.
//
// The two functions are emitted as their own SOURCE TEXT (Function.prototype.toString), so
// the three packages run byte-identical resolvers — not three resolvers a parity test says
// agree, which would make the duplicate permanent.
//
// It lives at the repo root for the same reason check-orphans.mjs does: a tool inside a
// package is a tool shipped to production.
//
// It also emits the module manifests (config/modules.mjs) into the packages that read them —
// the settings keys derived from them are already inside INSTANCE_KEYS.
//
// It also emits the AI adapter (config/ai-adapter.mjs) into the two backends, and the doctor's
// list (config/doctor.mjs) into web, under the same gate. Each of those files imports nothing and
// exports one name, so its copy is its own TEXT with the export rewritten for the package's module
// system — one list, not two that agree. (The box runs the release's config/doctor.mjs itself.)
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULES } from "../config/modules.mjs";
import { SETUP_CORE, setupProblems } from "../config/setup-core.mjs";
import { INSTANCE_KEYS, INSTANCE_KEY_PATTERNS, instanceEntry, parseInstanceValue, resolveInstanceValue, checkBackupTarget, runProviderCheck, normalizeCheckResult, describeCheck, parseBotBehavior, renderBotBehavior, messageVisibleSql } from "../config/instance-schema.mjs";

const REPO = resolve(fileURLToPath(import.meta.url), "../..");

// Per package: where the copy goes, its module syntax, and which names it exports. A name is
// exported only where another file in that package uses it — check-orphans fails an export
// nothing references, and an unused export would be one.
export const TARGETS = {
  "stream-api": {
    file: "stream-api/instanceSchema.generated.js",
    format: "cjs",
    exports: ["INSTANCE_KEYS", "MODULES", "instanceEntry", "parseInstanceValue", "resolveInstanceValue", "checkBackupTarget", "runProviderCheck", "normalizeCheckResult", "describeCheck", "parseBotBehavior", "messageVisibleSql"],
  },
  "stream-ingest": {
    file: "stream-ingest/lib/instanceSchema.generated.js",
    format: "esm",
    exports: ["INSTANCE_KEYS", "instanceEntry", "resolveInstanceValue", "runProviderCheck", "parseBotBehavior", "renderBotBehavior"],
  },
  web: {
    file: "web/app/lib/instanceSchema.generated.mjs",
    format: "esm",
    exports: ["INSTANCE_KEYS", "MODULES", "SETUP_CORE", "instanceEntry", "parseInstanceValue", "resolveInstanceValue", "checkBackupTarget", "runProviderCheck", "normalizeCheckResult", "describeCheck", "parseBotBehavior", "renderBotBehavior", "messageVisibleSql"],
  },
};

// The JSDoc types travel with the web copy so TypeScript reads typed entries out of a .mjs.
const TYPES = `/** @typedef {'string'|'list'|'origin'|'wsOrigin'|'url'|'serverName'|'matrixId'|'localpartTemplate'|'enum'|'secret'|'bool'|'number'|'aiRoute'|'aiTasks'|'aiConnections'|'memoryState'|'setupState'|'backupRepository'} InstanceKind */
/** @typedef {'web'|'stream-api'|'stream-ingest'} InstancePackage */
/**
 * @typedef {object} InstanceEntry
 * @property {string} key
 * @property {InstanceKind} kind
 * @property {null|string|string[]|boolean|number} default
 * @property {'public'|'server'} scope
 * @property {string} module
 * @property {boolean} secret
 * @property {'live'|'restart'} reload
 * @property {'install'|'instance'|'secret'} tier
 * @property {string[]} env
 * @property {InstancePackage[]} packages
 * @property {boolean} [required]
 * @property {string[]} [values]
 * @property {'serverName'} [items]
 * @property {string} [test]
 * @property {'ai'|'setup'|'rig'} [surface]
 * @property {'stream-api'} [writer]
 * @property {boolean} [nullable]
 * @property {boolean} [integer]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [maxLength]
 * @property {boolean} [productDefault]
 * @property {boolean} [legacyOn]
 * @property {string} label
 * @property {string} description
 */
/**
 * @typedef {object} InstanceResolution
 * @property {any} value
 * @property {'env'|'database'|'default'|'unset'} source
 * @property {string|null} envName
 * @property {string|null} error
 */
/**
 * @typedef {object} BotBehavior
 * @property {string} persona
 * @property {string[]} avoid
 * @property {{ text: string, tag: 'schedule'|'rules'|'links'|'jokes'|'other' }[]} facts
 * @property {{ replyLength: 'short'|'medium', swearing: 'allow'|'avoid', emoji: 'allow'|'avoid' }} settings
 */
/**
 * @typedef {object} CheckResult
 * @property {boolean} ok
 * @property {string} code
 * @property {number} [status]
 * @property {number} [count]
 * @property {'live'|'test'|'sandbox'} [mode]
 * @property {string[]} [missing]
 */
`;

const FN_TYPES = {
  instanceEntry: "/**\n * @param {unknown} key\n * @returns {InstanceEntry | null}\n */\n",
  parseInstanceValue:
    "/**\n * @param {InstanceEntry} entry\n * @param {unknown} raw\n * @returns {{ ok: true, value: any } | { ok: false, error: string }}\n */\n",
  resolveInstanceValue:
    "/**\n * @param {InstanceEntry} entry\n * @param {Record<string, string|undefined>|null|undefined} env\n * @param {Record<string, unknown>|null|undefined} db\n * @returns {InstanceResolution}\n */\n",
  runProviderCheck:
    "/**\n * @param {string} test\n * @param {(key: string) => any} get\n * @param {typeof fetch} fetchImpl\n * @returns {Promise<CheckResult | null>}\n */\n",
  normalizeCheckResult: "/**\n * @param {unknown} r\n * @returns {CheckResult}\n */\n",
  describeCheck: "/**\n * @param {CheckResult} r\n * @returns {string}\n */\n",
  parseBotBehavior:
    "/**\n * @param {unknown} text\n * @returns {{ ok: true, value: BotBehavior } | { ok: false, error: string }}\n */\n",
  renderBotBehavior:
    "/**\n * @param {BotBehavior} behavior\n * @param {number} [cap]\n * @returns {{ block: string, used: number, cap: number, omitted: number[] }}\n */\n",
  messageVisibleSql: "/**\n * @param {string} alias\n * @returns {string}\n */\n",
  checkBackupTarget:
    "/**\n * @param {unknown} target\n * @param {unknown} repository\n * @returns {{ ok: true, host: string|null } | { ok: false, error: string }}\n */\n",
};

export function render(pkg) {
  const t = TARGETS[pkg];
  if (!t) throw new Error(`unknown package ${pkg}`);
  const typed = pkg === "web";
  const out = [];
  out.push(
    "// GENERATED by tools/gen-instance-schema.mjs from config/instance-schema.mjs — DO NOT EDIT.",
    "// Edit the schema there and run `node tools/gen-instance-schema.mjs`; this package's",
    "// `check:instance-schema` (part of check:all) fails when this copy drifts.",
  );
  if (t.format === "cjs") out.push("'use strict';");
  out.push("");
  if (typed) out.push(TYPES);
  if (typed) out.push("/** @type {InstanceEntry[]} */");
  out.push(`const INSTANCE_KEYS = ${JSON.stringify(INSTANCE_KEYS, null, 2)};`, "");
  if (typed) out.push("/** @type {InstanceEntry[]} */");
  out.push(`const INSTANCE_KEY_PATTERNS = ${JSON.stringify(INSTANCE_KEY_PATTERNS, null, 2)};`, "");
  // The module manifests (config/modules.mjs) travel only to a package that reads them.
  if (t.exports.includes("MODULES")) out.push(`const MODULES = ${JSON.stringify(MODULES, null, 2)};`, "");
  // The setup pages' lists for the product's non-module parts (config/setup-core.mjs) — web only.
  if (t.exports.includes("SETUP_CORE")) out.push(`const SETUP_CORE = ${JSON.stringify(SETUP_CORE, null, 2)};`, "");
  // Emit only what this package uses (an unused emitted function is a lint error there).
  // parseInstanceValue always travels: resolveInstanceValue calls it.
  const ALL = [instanceEntry, parseInstanceValue, resolveInstanceValue, checkBackupTarget, runProviderCheck, normalizeCheckResult, describeCheck, parseBotBehavior, renderBotBehavior, messageVisibleSql];
  for (const fn of ALL.filter((f) => f === parseInstanceValue || t.exports.includes(f.name))) {
    if (typed) out.push(FN_TYPES[fn.name].trimEnd());
    // stream-api's copy is called from outside the package, which its orphan gate cannot see.
    if (!typed && fn === checkBackupTarget) {
      out.push("// @parked its consumer lives outside this package: install/backup/target.cjs runs this copy inside the stream-api image (the box reads its backup target with it)");
    }
    out.push(fn.toString(), "");
  }
  out.push(
    t.format === "cjs"
      ? `module.exports = { ${t.exports.join(", ")} };`
      : `export { ${t.exports.join(", ")} };`,
    "",
  );
  return out.join("\n");
}

// Text copies: one source file each (imports nothing, exports exactly `export const <NAME> = …`).
export const COPIES = [
  { source: "config/ai-adapter.mjs", name: "AI_ADAPTER", noun: "adapter", targets: {
    "stream-api": { file: "stream-api/aiAdapter.generated.js", format: "cjs" },
    "stream-ingest": { file: "stream-ingest/lib/aiAdapter.generated.js", format: "esm" },
  } },
  { source: "config/doctor.mjs", name: "DOCTOR", noun: "list", targets: {
    web: { file: "web/app/lib/doctor.generated.mjs", format: "esm" },
  } },
  // The public id (a person's per-platform pseudonym on every public surface): stream-api makes
  // it for the chat socket, web makes and reads it for the history, the card and mod lookups.
  { source: "config/public-id.mjs", name: "PUBLIC_ID", noun: "public id", targets: {
    "stream-api": { file: "stream-api/publicId.generated.js", format: "cjs" },
    web: { file: "web/app/lib/publicId.generated.mjs", format: "esm" },
  } },
];
// The AI adapter's copies — the two backends only (web makes no model calls).
export const ADAPTER_TARGETS = COPIES[0].targets;

/** A copy's text: `copy` is an entry of COPIES (default: the AI adapter); `source` its text. */
export function renderCopy(pkg, copy = COPIES[0], source = readFileSync(join(REPO, copy.source), "utf8")) {
  const t = copy.targets[pkg];
  if (!t) throw new Error(`no ${copy.source} copy for ${pkg}`);
  if (/^\s*import\b/m.test(source)) throw new Error(`${copy.source} must import nothing — its text is copied into another package`);
  const exports = source.match(/^export\b.*$/gm) || [];
  if (exports.length !== 1 || !exports[0].startsWith(`export const ${copy.name} = `)) {
    throw new Error(`${copy.source} must export exactly one name, \`export const ${copy.name} = …\``);
  }
  const body = source.replace(`export const ${copy.name} = `, `const ${copy.name} = `);
  return [
    `// GENERATED by tools/gen-instance-schema.mjs from ${copy.source} — DO NOT EDIT.`,
    `// Edit the ${copy.noun} there and run \`node tools/gen-instance-schema.mjs\`; this package's`,
    "// `check:instance-schema` (part of check:all) fails when this copy drifts.",
    ...(t.format === "cjs" ? ["'use strict';"] : []),
    "",
    body.trimEnd(),
    "",
    t.format === "cjs" ? `module.exports = { ${copy.name} };` : `export { ${copy.name} };`,
    "",
  ].join("\n");
}
/** The AI adapter's copy (kept for its tests). */
export function renderAdapter(pkg, source) {
  return renderCopy(pkg, COPIES[0], source);
}

/** True when `have` (a copy's current text, or null if missing) is exactly what the schema generates. */
export function isCurrent(pkg, have) {
  return have === render(pkg);
}

/** The setup lists' shape check (config/setup-core.mjs), run by both modes: a bad step fails
 *  check:instance-schema in every package, and is never written into a copy. */
function setupGate(modules, core) {
  const problems = setupProblems({ modules, core, keys: INSTANCE_KEYS });
  for (const p of problems) console.error(`check-instance-schema: setup — ${p}`);
  return problems.length === 0;
}

/** `modules` / `core` default to the real lists; the gate's own test passes broken ones. */
export function main(argv, { modules = MODULES, core = SETUP_CORE } = {}) {
  if (!setupGate(modules, core)) return 1;
  const check = argv.indexOf("--check");
  if (check >= 0) {
    const pkg = argv[check + 1];
    if (!TARGETS[pkg]) {
      console.error(`gen-instance-schema: --check needs a package (${Object.keys(TARGETS).join(", ")})`);
      return 2;
    }
    const path = join(REPO, TARGETS[pkg].file);
    let have = null;
    try { have = readFileSync(path, "utf8"); } catch { /* reported below */ }
    if (!isCurrent(pkg, have)) {
      console.error(
        `check-instance-schema (${pkg}): ${TARGETS[pkg].file} ${have === null ? "is missing" : "has drifted from config/instance-schema.mjs"}.\n` +
          "  Regenerate: node tools/gen-instance-schema.mjs   (never hand-edit the generated copy)",
      );
      return 1;
    }
    const copied = [];
    for (const copy of COPIES.filter((c) => c.targets[pkg])) {
      const file = copy.targets[pkg].file;
      let have2 = null;
      try { have2 = readFileSync(join(REPO, file), "utf8"); } catch { /* reported below */ }
      if (have2 !== renderCopy(pkg, copy)) {
        console.error(
          `check-instance-schema (${pkg}): ${file} ${have2 === null ? "is missing" : `has drifted from ${copy.source}`}.\n` +
            "  Regenerate: node tools/gen-instance-schema.mjs   (never hand-edit the generated copy)",
        );
        return 1;
      }
      copied.push(`; ${file} matches ${copy.source}`);
    }
    console.log(`check-instance-schema (${pkg}): ok — ${INSTANCE_KEYS.length} keys, ${TARGETS[pkg].file} matches the schema${copied.join("")}`);
    return 0;
  }
  for (const pkg of Object.keys(TARGETS)) {
    writeFileSync(join(REPO, TARGETS[pkg].file), render(pkg));
    console.log(`wrote ${TARGETS[pkg].file}`);
  }
  for (const copy of COPIES) {
    for (const pkg of Object.keys(copy.targets)) {
      writeFileSync(join(REPO, copy.targets[pkg].file), renderCopy(pkg, copy));
      console.log(`wrote ${copy.targets[pkg].file}`);
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
