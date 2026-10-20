#!/usr/bin/env node
// Finds REAL Next.js Server→Client prop-serialization violations, as opposed to the noisy
// IDE-only heuristic that flags them.
//
// Background: tsconfig.json registers next's TypeScript *language-service* plugin
// (compilerOptions.plugins: [{name:"next"}]). Its client-boundary rule
// (node_modules/next/dist/server/typescript/rules/client-boundary.ts) flags any function-typed
// prop on any exported component in ANY "use client" file — it has no idea who actually renders
// the component, so legal client-to-client prop passing looks identical to it as an illegal
// server-to-client crossing. It's LS-plugin-only: `tsc --noEmit`, eslint, and `next build` never
// see it (LS plugins don't run under the tsc CLI), so it shows up only in the editor's Problems
// panel. In an audit, every instance flagged across web/ was a false positive — none of the
// flagged files were reachable from a genuine Server Component.
// There is no supported way to suppress just this rule (no ts-ignore support in the plugin, no
// vscode per-code diagnostic filter — see microsoft/vscode#219335, #192189) short of disabling
// next's whole TS plugin, which would also drop its other genuinely useful rules (error.tsx must
// be a Client Component, metadata forbidden in Client Components, "use server" export shape,
// disallowed Server Component APIs, page/layout/route config validation).
//
// This script re-implements the client-boundary heuristic via the compiler API, then goes further
// than the IDE plugin does: it traces the REAL Next.js app-router import graph from every root
// file (page/layout/template/default/loading/not-found/route/error) and checks whether a flagged
// component is ever JSX-rendered with the flagged prop set to a function expression from a call
// site that is still reachable in "server" mode (i.e. no "use client" crossed yet on that path).
// Only those are real bugs.
//
// KNOWN GAPS (why this isn't wired into check:all): the import graph only follows static
// import/export declarations — it does not follow next/dynamic()/import() calls, so a file only
// ever reached via a dynamic import from a Server Component would show as "unreached" here rather
// than correctly attributed. When audited, every next/dynamic() call site lived inside an
// already-"use client" file, so this gap hid nothing — but that can change. Treat "0 real bugs"
// as strong evidence, not a proof, and spot-check any new next/dynamic() usage in a Server
// Component by hand.
//
// Usage: node scripts/check-client-boundary.mjs [--list]
//   (no flag)  full audit — prints only real Server→Client violations (should be empty)
//   --list     also print every raw flagged instance (what the IDE Problems panel shows you)

import ts from "typescript";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const showList = process.argv.includes("--list");

const configPath = ts.findConfigFile(projectDir, ts.sys.fileExists, "tsconfig.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
const program = ts.createProgram({ options: parsed.options, rootNames: parsed.fileNames });
const checker = program.getTypeChecker();

// TS gives root files relative fileNames and import-resolved files absolute ones (or vice versa,
// inconsistently) -- normalize every file identity through this before using it as a map key.
const abs = (f) => path.normalize(path.resolve(projectDir, f));
const rel = (f) => path.relative(projectDir, f);

const allSourceFiles = program
  .getSourceFiles()
  .filter((sf) => !program.isSourceFileFromExternalLibrary(sf) && /\.(tsx|ts)$/.test(sf.fileName));
const byName = new Map(allSourceFiles.map((sf) => [abs(sf.fileName), sf]));

function hasUseClient(source) {
  for (const stmt of source.statements) {
    if (!ts.isExpressionStatement(stmt)) break;
    if (!ts.isStringLiteral(stmt.expression)) break;
    if (stmt.expression.text === "use client") return true;
  }
  return false;
}

// ---------- 1. import graph: absFile -> Set(absFile), plus local-binding -> absFile map ----------
const importGraph = new Map();
const localImportMap = new Map();

function resolveSpecifier(spec, containingFile) {
  const res = ts.resolveModuleName(spec, containingFile, parsed.options, ts.sys);
  if (res.resolvedModule && !res.resolvedModule.isExternalLibraryImport) {
    return abs(res.resolvedModule.resolvedFileName);
  }
  return null;
}

for (const sf of allSourceFiles) {
  const sfAbs = abs(sf.fileName);
  const targets = new Set();
  const locals = new Map();
  ts.forEachChild(sf, (node) => {
    let spec = null;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      spec = node.moduleSpecifier.text;
    }
    if (!spec) return;
    const resolved = resolveSpecifier(spec, sf.fileName);
    if (!resolved || !byName.has(resolved)) return;
    targets.add(resolved);

    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) locals.set(clause.name.text, resolved);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) locals.set(el.name.text, resolved);
      }
    }
  });
  importGraph.set(sfAbs, targets);
  localImportMap.set(sfAbs, locals);
}

// ---------- 2. BFS from Next.js root files, tracking server/client reachability ----------
const ROOT_RE = /(^|[\\/])(page|layout|template|default|loading|not-found|error|global-error|route)\.(tsx|ts)$/;
const roots = allSourceFiles.filter((sf) => {
  const a = abs(sf.fileName);
  return /(^|[\\/])app([\\/]|$)/.test(a) && ROOT_RE.test(a);
});

const reach = new Map(); // absFile -> Set('server'|'client')
function markReach(fileName, mode) {
  if (!reach.has(fileName)) reach.set(fileName, new Set());
  const set = reach.get(fileName);
  if (set.has(mode)) return false;
  set.add(mode);
  return true;
}

const queue = [];
for (const root of roots) {
  const rootAbs = abs(root.fileName);
  const mode = hasUseClient(root) ? "client" : "server";
  if (markReach(rootAbs, mode)) queue.push([rootAbs, mode]);
}
while (queue.length) {
  const [fileName, mode] = queue.shift();
  const targets = importGraph.get(fileName) || new Set();
  for (const t of targets) {
    const targetSf = byName.get(t);
    const newMode = mode === "client" ? "client" : hasUseClient(targetSf) ? "client" : "server";
    if (markReach(t, newMode)) queue.push([t, newMode]);
  }
}

// ---------- 3. re-derive the flagged-props list (mirrors client-boundary.ts exactly) ----------
function checkFunctionExport(source, fnNode, exportName) {
  const props = fnNode.parameters && fnNode.parameters[0];
  if (!props) return [];
  const propsType = checker.getTypeAtLocation(props);
  const typeNode = propsType.symbol?.getDeclarations()?.[0];
  if (!typeNode || !ts.isTypeLiteralNode(typeNode)) return [];
  const hits = [];
  for (const member of typeNode.members) {
    if (!ts.isPropertySignature(member)) continue;
    const propName = member.name.getText();
    const propType = member.type;
    if (!propType) continue;
    const propTypeInfo = checker.getTypeAtLocation(propType);
    const decl = propTypeInfo.symbol?.getDeclarations()?.[0];
    if (!decl) continue;
    const isFn = ts.isFunctionTypeNode(decl) || ts.isMethodSignature(decl);
    const isClassy = ts.isConstructorTypeNode(decl) || ts.isClassDeclaration(decl);
    if (!isFn && !isClassy) continue;
    const maybeServerAction = propName === "action" || /.+Action$/.test(propName);
    const isErrorFile = /[\\/]error\.tsx?$/.test(source.fileName);
    const isGlobalErrorFile = /[\\/]global-error\.tsx?$/.test(source.fileName);
    const isErrorBoundaryProp = (isErrorFile || isGlobalErrorFile) && (propName === "reset" || propName === "retry");
    if (isFn && (maybeServerAction || isErrorBoundaryProp)) continue;
    hits.push({ file: abs(source.fileName), exportName, propName, isFn, isClassy });
  }
  return hits;
}

const flagged = [];
for (const source of allSourceFiles) {
  if (!hasUseClient(source)) continue;
  ts.forEachChild(source, (node) => {
    if (ts.isFunctionDeclaration(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      const isDefault = node.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      const name = isDefault ? "default" : node.name ? node.name.text : "default";
      flagged.push(...checkFunctionExport(source, node, name));
    } else if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && ts.isArrowFunction(decl.initializer)) {
          flagged.push(...checkFunctionExport(source, decl.initializer, decl.name.getText()));
        }
      }
    }
  });
}

if (showList) {
  console.log(`=== ${flagged.length} raw INVALID_CLIENT_ENTRY_PROP flag(s) (what the IDE Problems panel shows) ===`);
  for (const h of flagged) {
    console.log(`${rel(h.file)}  [${h.exportName}] prop "${h.propName}" (${h.isFn ? "function-prop" : "class-prop"})`);
  }
  console.log("");
}

const flaggedByFile = new Map(); // absFile -> Map<exportName, Set<propName>>  (function-props only)
for (const h of flagged) {
  if (!h.isFn) continue;
  if (!flaggedByFile.has(h.file)) flaggedByFile.set(h.file, new Map());
  const m = flaggedByFile.get(h.file);
  if (!m.has(h.exportName)) m.set(h.exportName, new Set());
  m.get(h.exportName).add(h.propName);
}

// ---------- 4. JSX call sites in server-reachable files rendering a flagged component ----------
function isFunctionValuedExpr(expr) {
  if (!expr) return false;
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return true;
  try {
    return checker.getTypeAtLocation(expr).getCallSignatures().length > 0;
  } catch {
    return false;
  }
}

const realBugs = [];
const serverReachableFiles = allSourceFiles.filter((sf) => (reach.get(abs(sf.fileName)) || new Set()).has("server"));

for (const sf of serverReachableFiles) {
  const sfAbs = abs(sf.fileName);
  const locals = localImportMap.get(sfAbs) || new Map();
  const relevantLocals = [...locals.entries()].filter(([, resolved]) => flaggedByFile.has(resolved));
  if (relevantLocals.length === 0) continue;
  const localToFile = new Map(relevantLocals);

  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tagName = node.tagName.getText();
      const resolvedFile = localToFile.get(tagName);
      if (resolvedFile) {
        const exportsMap = flaggedByFile.get(resolvedFile);
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || !attr.name) continue;
          const attrName = attr.name.getText();
          let flaggedHere = false;
          for (const [, propNames] of exportsMap) {
            if (propNames.has(attrName)) {
              flaggedHere = true;
              break;
            }
          }
          if (!flaggedHere) continue;
          const init = attr.initializer;
          const expr = init && ts.isJsxExpression(init) ? init.expression : null;
          if (isFunctionValuedExpr(expr)) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
            realBugs.push({
              callSite: `${rel(sfAbs)}:${line + 1}`,
              tag: tagName,
              prop: attrName,
              targetFile: rel(resolvedFile),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

console.log("=== REAL Server→Client boundary violations ===");
if (realBugs.length === 0) {
  console.log("(none found)");
} else {
  for (const b of realBugs) console.log(`${b.callSite}  <${b.tag} ${b.prop}={...}>  → ${b.targetFile}`);
}
console.log(
  `\n${realBugs.length} real bug candidate(s) out of ${flagged.filter((h) => h.isFn).length} function-prop flags across ${flaggedByFile.size} files (${flagged.length} total flags incl. class-typed props). Run with --list to see every raw flag.`
);

process.exit(realBugs.length > 0 ? 1 : 0);
