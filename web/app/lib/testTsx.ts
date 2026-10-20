// @test-only test infrastructure — a TSX module loader for `node --test`, not product code.
// Lets a test mount a REAL .tsx component instead of a hand-rebuilt copy of it.
//
// Why it exists: `node --test` strips types from .ts but does not PARSE JSX, so
// importing a component outright fails with ERR_UNKNOWN_FILE_EXTENSION — and the
// components additionally import through the "@/" alias, which node does not
// resolve. Without this, a component test has to reconstruct the component's
// tree by hand, which means asserting against a copy: exactly the trap
// testDom.ts's header describes, where every line of the real thing is present
// and correctly ordered while its BEHAVIOUR is wrong. A first-mount bug (a ref
// that attaches after another component's layout effects) is invisible to
// source-scan assertions and takes one real mount to see.
//
// How: synchronous `module.registerHooks` — a resolver for "@/" and
// extensionless specifiers, and a loader that runs .tsx through TypeScript's
// `transpileModule`. No new dependency: `typescript` is already here, it is what
// the build's `tsc --noEmit` gate runs.
//
// The hooks are PROCESS-local, and `node --test` runs each test FILE in its
// own process, so they cannot leak into another suite.
//
// Import order matters: ./testDom.ts is imported first so the jsdom globals
// are installed before anything pulls in react-dom/client (see its own header).
//
// `.ts` extensions are REQUIRED on imports of this module and its callees:
// `node --test` cannot resolve extensionless TypeScript specifiers.

import { dom } from "./testDom.ts";
import * as nodeModule from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTS = [".ts", ".tsx", ".js", ".mjs"];

function resolveFile(base: string): string | null {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const e of EXTS) if (existsSync(base + e)) return base + e;
  // A directory import (a barrel: "@/app/components/chrome") resolves to its
  // index — check-chrome.mjs requires consumers to import chrome ONLY that
  // way, so a render test proving "the barrel is a real door" needs this too.
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const e of EXTS) if (existsSync(path.join(base, "index" + e))) return path.join(base, "index" + e);
  }
  return null;
}

// This tree's @types/node is 20.x, which predates `module.registerHooks` (the
// synchronous, in-thread hook API). Declaring the slice used here keeps the
// callbacks properly typed instead of casting them to `any`.
type ResolveContext = { parentURL?: string };
type ResolveResult = { url: string; format?: string; shortCircuit?: boolean };
type LoadResult = { format: string; source: string; shortCircuit?: boolean };
type ModuleHooks = {
  resolve(specifier: string, context: ResolveContext, next: (s: string, c: ResolveContext) => ResolveResult): ResolveResult;
  load(url: string, context: unknown, next: (u: string, c: unknown) => LoadResult): LoadResult;
};
const registerHooks = (nodeModule as unknown as { registerHooks: (hooks: ModuleHooks) => void }).registerHooks;

// Registered at module body: importing this file is what arms the loader, so a
// test's own `await import("@/app/components/…")` resolves and transpiles.
registerHooks({
  resolve(specifier, context, nextResolve) {
    let base: string | null = null;
    // The owner seam, resolved as next.config.ts does: the install's app/(owner)/<area>.ts, else the
    // empty plugin. TEST_NO_OWNER=1 renders as the public build would (no owner folder).
    if (specifier.startsWith("@owner/")) {
      const area = specifier.slice("@owner/".length);
      const own = path.join(WEB, "app", "(owner)", `${area}.ts`);
      base = process.env.TEST_NO_OWNER !== "1" && existsSync(own) ? own : path.join(WEB, "app", "lib", "plugins", "absent", `${area}.ts`);
    } else if (specifier.startsWith("@/")) base = path.join(WEB, specifier.slice(2));
    else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    }
    const hit = base ? resolveFile(base) : null;
    if (!hit) {
      // A bare package subpath with no `exports` map ("next/link") resolves in
      // Next's bundler by extension search, which node's ESM loader refuses. A
      // component that only IMPORTS it (UserCard's Link, rendered on a click,
      // never at SSR) still needs the import to load — fall back to the same
      // extension search under node_modules, after node has had its say.
      try {
        return nextResolve(specifier, context);
      } catch (e) {
        const nm = !specifier.startsWith("node:") && !path.isAbsolute(specifier) && !specifier.startsWith(".")
          ? resolveFile(path.join(WEB, "node_modules", specifier))
          : null;
        if (!nm) throw e;
        return { url: pathToFileURL(nm).href, shortCircuit: true };
      }
    }
    return { url: pathToFileURL(hit).href, shortCircuit: true, ...(hit.endsWith(".tsx") ? { format: "module" as const } : {}) };
  },
  load(url, context, nextLoad) {
    // A component's own stylesheet import (`import "./x.css"` — global CSS, which the bundler
    // handles): nothing to run under node.
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    }).outputText;
    return { format: "module", source, shortCircuit: true };
  },
});

/** A stubbed ResizeObserver: what it was pointed at, and a way to deliver an observation. */
export type ResizeObserverStub = {
  /**
   * Deliver the observation a real ResizeObserver makes as soon as it observes.
   * Synchronous on purpose — the caller wraps it in `act` so React flushes the
   * work it triggers.
   */
  fire(): void;
  /** Every element handed to `observe()`, in order, across all live observers. */
  observed: Element[];
};

/**
 * Install a recording ResizeObserver on the jsdom window and globalThis.
 *
 * jsdom implements none, so a component that constructs one unconditionally
 * throws inside its layout effect and React reports a mount failure instead of
 * the missing global it is. The initial observation a real ResizeObserver makes
 * is also load-bearing for anything measuring after the refs are attached, and
 * only a stub can deliver that on demand.
 */
export function installResizeObserverStub(): ResizeObserverStub {
  const live: { cb: () => void }[] = [];
  const observed: Element[] = [];

  class RecordingResizeObserver {
    private readonly entry: { cb: () => void };
    constructor(cb: () => void) {
      this.entry = { cb };
      live.push(this.entry);
    }
    observe(target: Element) { observed.push(target); }
    unobserve() {}
    disconnect() {
      const i = live.indexOf(this.entry);
      if (i >= 0) live.splice(i, 1);
    }
  }

  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
  (dom.window as unknown as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;

  return {
    fire() { for (const o of live.slice()) o.cb(); },
    observed,
  };
}

/** A stubbed `requestAnimationFrame` queue: `flush()` runs whatever is pending. */
export type RafStub = {
  /** Run every callback currently queued (not ones a running callback itself queues — one frame). */
  flush(): void;
  /** Restore whatever `requestAnimationFrame`/`cancelAnimationFrame` were before this ran. */
  uninstall(): void;
};

/**
 * Install a manual `requestAnimationFrame` / `cancelAnimationFrame` on
 * `globalThis`, following the same one-frame-at-a-time queue
 * `testDom.ts:fakePhoneViewport` uses for the keyboard-lift hooks.
 *
 * jsdom implements neither: Node has no browser event loop to schedule a
 * frame on, so an effect that calls bare `requestAnimationFrame` throws
 * ReferenceError and React reports a mount failure instead of the missing
 * global it is. A real timer-based rAF would also make a hysteresis test
 * racy against `act()`; a caller-driven `flush()` keeps each pointermove's
 * frame synchronous and deterministic instead.
 *
 * Call at MODULE scope (the `installResizeObserverStub` precedent this file
 * already sets), not inside a test body: this overwrites a `globalThis`
 * global for the whole process, so installing it mid-test leaves it live —
 * silently — for every later test in the file. `uninstall()` exists for a
 * caller that genuinely needs narrower scope and is willing to restore it.
 */
export function installRafStub(): RafStub {
  const queue = new Map<number, FrameRequestCallback>();
  let id = 0;
  const g = globalThis as unknown as { requestAnimationFrame: unknown; cancelAnimationFrame: unknown };
  const prevRaf = g.requestAnimationFrame;
  const prevCancel = g.cancelAnimationFrame;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => { const h = ++id; queue.set(h, cb); return h; };
  g.cancelAnimationFrame = (handle: number) => { queue.delete(handle); };
  return {
    flush() {
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(0);
    },
    uninstall() {
      g.requestAnimationFrame = prevRaf;
      g.cancelAnimationFrame = prevCancel;
    },
  };
}

/** A stubbed box. The chrome measurements read a rect's `left` and `width` and nothing else. */
export type FakeBox = { left: number; width: number };

/**
 * Give jsdom elements real boxes.
 *
 * jsdom lays nothing out — every `getBoundingClientRect()` is zero — which would
 * make "the indicator moved" indistinguishable from "the indicator closed", and
 * would make a band-space measurement indistinguishable from a strip-space one.
 * Both render tests need the same stubbing, so it lives here rather than in
 * either of them.
 *
 * `boxes` maps a selector to a box, or to a function of the match index when a
 * selector has several matches (the tabs). EVERY match is stubbed.
 *
 * Stub the CONTAINERS a measurement is relative to, not just the things being
 * measured: leaving `[role="tablist"]` at zero lets a strip-space implementation
 * produce the band-space answer by accident, and the fixture proves nothing.
 */
export function fakeLayout(root: Element, boxes: Record<string, FakeBox | ((i: number) => FakeBox)>): void {
  for (const [selector, spec] of Object.entries(boxes)) {
    root.querySelectorAll(selector).forEach((el, i) => {
      const { left, width } = typeof spec === "function" ? spec(i) : spec;
      // top/bottom/height are filled in for SHAPE only — nothing reads them.
      const rect = { left, width, right: left + width, top: 0, bottom: 36, height: 36, x: left, y: 0, toJSON() {} };
      Object.defineProperty(el, "getBoundingClientRect", { value: () => rect, configurable: true });
    });
  }
}
