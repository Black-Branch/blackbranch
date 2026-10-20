// Loading the two platform API scripts, once each, with a definite answer.
//
// THIS MODULE EXISTS TO MAKE A BLOCKED SCRIPT A NON-EVENT. Every viewer
// running an ad blocker will fail to fetch these, and the adapters they enable
// are enhancements — playback must be completely unaffected. So `load` never
// rejects and never hangs: it resolves false. And `ready` answers
// SYNCHRONOUSLY, so a player mounting can choose adapter-or-plain-iframe
// without waiting for a script that is never coming.
//
// The environment is injected for the same reason createWhepProxy takes
// `fetch`: node --test has no DOM, and the interesting behaviour here is the
// bookkeeping, not the DOM call.
import type { AdapterSource } from "./playerAdapter";

// @test-only playerScripts.test.ts pins the two script URLs directly; product
// code never reads this map — it only calls load()/ready().
export const SCRIPT_URL: Record<AdapterSource, string> = {
  youtube: "https://www.youtube.com/iframe_api",
  twitch: "https://embed.twitch.tv/embed/v1.js",
};

/**
 * Is the API actually callable, not just its namespace present? Per source,
 * because "present" means something different for each: YouTube's loader
 * publishes `window.YT = { loading: 1 }` well before the real widget script
 * defines `YT.Player`, so testing for `YT` alone is true for 50-200ms before
 * `new YT.Player(...)` can succeed. Twitch does not have this two-stage
 * loader, but is checked the same way rather than by a bare namespace test,
 * so a future API that grows one does not silently regress this file.
 */
const isUsable: Record<AdapterSource, (win: Record<string, unknown>) => boolean> = {
  youtube: (win) => typeof (win.YT as { Player?: unknown } | undefined)?.Player === "function",
  twitch: (win) => typeof (win.Twitch as { Player?: unknown } | undefined)?.Player === "function",
};

/**
 * A script can fire `load` and still not be usable: YouTube's iframe_api is a
 * loader that fetches the real widget API and only then defines window.YT.
 */
// @test-only playerScripts.test.ts drives this timeout directly against a fake
// clock; product code never reads the constant — it only calls load()/ready().
export const SCRIPT_TIMEOUT_MS = 5000;
const POLL_MS = 50;

export type ScriptEnv = {
  win: Record<string, unknown>;
  appendScript(src: string, onload: () => void, onerror: () => void): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
};

export type ScriptLoader = {
  /** Fetch if needed. Resolves true when the API is usable, false when it is not. */
  load(source: AdapterSource): Promise<boolean>;
  /** Is the API usable RIGHT NOW? Never blocks. */
  ready(source: AdapterSource): boolean;
};

export function createScriptLoader(env: ScriptEnv): ScriptLoader {
  const pending = new Map<AdapterSource, Promise<boolean>>();
  const settled = new Map<AdapterSource, boolean>();

  const hasGlobal = (source: AdapterSource) => isUsable[source](env.win);

  function load(source: AdapterSource): Promise<boolean> {
    const already = settled.get(source);
    if (already !== undefined) return Promise.resolve(already);
    const inFlight = pending.get(source);
    if (inFlight) return inFlight;

    const p = new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        settled.set(source, ok);
        pending.delete(source);
        resolve(ok);
      };

      const deadline = env.now() + SCRIPT_TIMEOUT_MS;
      const timer = env.setTimeout(() => finish(false), SCRIPT_TIMEOUT_MS);

      // The global may appear after `load` fires (YouTube's loader-of-a-loader),
      // so waiting on it is what actually decides success.
      const awaitGlobal = () => {
        if (hasGlobal(source)) { env.clearTimeout(timer); finish(true); return; }
        if (env.now() >= deadline) { finish(false); return; }
        env.setTimeout(awaitGlobal, POLL_MS);
      };

      try {
        env.appendScript(
          SCRIPT_URL[source],
          awaitGlobal,
          () => { env.clearTimeout(timer); finish(false); },
        );
      } catch {
        env.clearTimeout(timer);
        finish(false);
      }
    });

    pending.set(source, p);
    return p;
  }

  return { load, ready: (source) => settled.get(source) === true && hasGlobal(source) };
}

/** The real browser environment. Not exercised by tests — the policy above is. */
export function browserScriptEnv(): ScriptEnv {
  return {
    win: window as unknown as Record<string, unknown>,
    appendScript(src, onload, onerror) {
      const el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.onload = onload;
      el.onerror = onerror;
      document.head.appendChild(el);
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
}
