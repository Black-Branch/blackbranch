'use strict';
// Extract stream-api's HTTP route surface from source.
//
// WHY THIS EXISTS. The catastrophic failure mode for the H7 decomposition of
// index.js is not a crash — it is a route quietly losing `requireInternal`, or
// disappearing, while everything still boots and the suite still passes. The
// money and mod endpoints live in that file. So the surface is snapshotted as a
// contract you can diff across a refactor.
//
// It deliberately scans EVERY stream-api source file, not index.js: when routes
// move into `registerX(app, deps)` modules the table must come out identical.
// That is the whole point — the snapshot follows the routes wherever they land.

const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');

// app.get('/path', requireInternal, wrap(…)  — leading whitespace allowed, since
// a route inside a register function is indented.
const ROUTE_RE = /^[ \t]*app\.(get|post|put|delete|patch)\(\s*'([^']+)'((?:\s*,\s*[A-Za-z_][A-Za-z0-9_.]*)*)/gm;

/**
 * Source files to scan: every .js in the directory except tests and this file — and in the
 * install's owner/ folder, whose routes are as much a part of the running surface. Owner
 * files are named `owner/<f>`.
 */
function sourceFiles(dir) {
  const js = (f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'routeSurface.js';
  const own = existsSync(join(dir, 'owner')) ? readdirSync(join(dir, 'owner')).filter(js).map((f) => `owner/${f}`) : [];
  return [...readdirSync(dir).filter(js), ...own].sort();
}

/**
 * Middleware named between the path and the handler. `wrap` is the async error
 * wrapper, not policy — dropped so the table shows only the auth/guard posture.
 */
function middlewareOf(tail) {
  return tail
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s !== 'wrap' && !s.startsWith('wrap('))
    .filter((s) => !/^async$/.test(s));
}

function extractFrom(src) {
  const out = [];
  let m;
  ROUTE_RE.lastIndex = 0;
  while ((m = ROUTE_RE.exec(src)) !== null) {
    out.push({
      method: m[1].toUpperCase(),
      path: m[2],
      middleware: middlewareOf(m[3] ?? ''),
    });
  }
  return out;
}

function collectRoutes(dir) {
  const routes = [];
  for (const file of sourceFiles(dir)) {
    for (const r of extractFrom(readFileSync(join(dir, file), 'utf8'))) {
      routes.push({ ...r, file });
    }
  }
  return routes;
}

/** One stable line per route. File is EXCLUDED on purpose — moving a route between
 *  files is exactly what H7 does, and must not read as a contract change. */
function routeLine(r) {
  const mw = r.middleware.length ? ` [${r.middleware.join(' ')}]` : ' [PUBLIC]';
  return `${r.method} ${r.path}${mw}`;
}

/** The contract: sorted, so file order and moves don't churn the diff. */
function surface(dir) {
  return collectRoutes(dir).map(routeLine).sort();
}

/**
 * The surface split by where the routes come from: `product` is what a public install
 * (no owner/ folder) can mount, `owner` what this install's owner plugin adds. Same lines as
 * surface(), partitioned by file.
 */
function surfaceByOrigin(dir) {
  const routes = collectRoutes(dir);
  const isOwner = (r) => r.file.startsWith('owner/');
  return {
    product: routes.filter((r) => !isOwner(r)).map(routeLine).sort(),
    owner: routes.filter(isOwner).map(routeLine).sort(),
  };
}

/**
 * Pairs where one route could SHADOW another in Express (first match wins): a
 * literal segment vs a `:param` at the same position and depth. Registration
 * order between these is load-bearing, and moving code is exactly what breaks
 * it — so the order of each pair is part of the contract too.
 */
function shadowPairs(dir) {
  const routes = collectRoutes(dir);
  const pairs = [];
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i], b = routes[j];
      if (a.method !== b.method) continue;
      const as = a.path.split('/'), bs = b.path.split('/');
      if (as.length !== bs.length) continue;
      let collides = false, compatible = true;
      for (let k = 0; k < as.length; k++) {
        const x = as[k], y = bs[k];
        if (x === y) continue;
        const xp = x.startsWith(':'), yp = y.startsWith(':');
        if (xp || yp) collides = true;      // one side matches anything here
        else { compatible = false; break; } // two different literals — disjoint
      }
      if (collides && compatible) pairs.push(`${a.method} ${a.path} BEFORE ${b.path}`);
    }
  }
  return pairs.sort();
}

/**
 * The surface per module: for each manifest that owns routes, the
 * route lines found in its `api.files`. A switched-off module's routes are not mounted, so the
 * surface of any configuration is surface() minus the lines of the modules that are off.
 */
function moduleSurfaces(dir, modules) {
  const routes = collectRoutes(dir);
  const out = {};
  for (const m of modules) {
    // A manifest names a module's files by base name: they sit at the top level or, for an owner
    // module, in owner/ — config/ never names the owner folder.
    const lines = routes.filter((r) => m.api.files.includes(r.file.replace(/^owner\//, ''))).map(routeLine).sort();
    if (lines.length) out[m.id] = lines;
  }
  return out;
}

module.exports = { collectRoutes, surface, surfaceByOrigin, shadowPairs, moduleSurfaces };
