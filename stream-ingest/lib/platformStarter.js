// The platform chat readers: which ones run, and what state each one is in.
//
// The choice (lib/platformsEnv.js) reads the settings, so the readers follow the settings: the
// starter RECONCILES on every settings load — the boot load, a reconnect, a `config_changed`
// frame (an admin saving a channel), the 5-minute backstop. A platform switched on later starts
// without a restart; one switched off (its channel cleared, YouTube's switch turned off) stops; one
// whose channel changed is stopped and started again with the new one. A reader that is running
// with the same values is left alone, so a later load never starts a second copy of it.
//
// A reader whose start threw has no handle and is `failed` with a one-line reason; every later
// pass tries it again (the Kick reader throws while its channel is unknown). Passes are
// serialised: a load that lands while a pass is still starting a reader waits for it rather than
// starting that reader a second time.
//
// State per platform, served by lib/health.js:
//   off       not chosen by the settings
//   starting  its start is in flight (or the reader says it is still connecting)
//   running   started (and, for a reader that can tell, connected)
//   failed    its start threw, or the reader reports it cannot work; `error` says why in one line

/** A reader's error as one line a viewer could read: no stack, no URL query, at most 200 chars. */
export function oneLine(err) {
  const raw = err?.message || String(err ?? 'unknown error');
  const first = raw.split('\n').map((l) => l.trim()).find((l) => l && !/^[=╔╚║─━-]+/.test(l)) || 'unknown error';
  // A URL keeps its host; a path or query can carry a channel id or a token.
  const clean = first.replace(/https?:\/\/([^/\s?#]+)[^\s]*/g, '$1');
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}

/**
 * @param {{
 *   starters: Record<string, () => Promise<object>>,
 *   choose: () => { enabled: string[], unknown: string[], note: string, signatures?: Record<string, string> },
 *   onApplied?: (name: string) => void,
 *   now?: () => number,
 *   log?: Pick<Console, 'log'|'warn'|'error'>,
 * }} opts
 */
export function createPlatformStarter({ starters, choose, onApplied = () => {}, now = () => Date.now(), log = console }) {
  const handles = new Map(); // name → the started reader's handle
  const sigs = new Map();    // name → the values its reader was started with
  const states = new Map();  // name → { state, since, error }
  let wanted = [];
  let lastNote = null;
  let queue = Promise.resolve();
  let closed = false;

  function setState(name, state, error = '') {
    const cur = states.get(name);
    if (cur && cur.state === state && cur.error === error) return;
    states.set(name, { state, since: now(), error });
  }
  for (const name of Object.keys(starters)) setState(name, 'off');

  async function stopOne(name, why) {
    const h = handles.get(name);
    handles.delete(name);
    sigs.delete(name);
    try { await h?.stop?.(); } catch (e) { log.warn(`[main] ${name} stop: ${oneLine(e)}`); }
    log.log(`[main] ${name} stopped (${why})`);
  }

  async function startOne(name, sig) {
    // A retry of a failed reader stays `failed` (and keeps its since) until it actually starts.
    if (states.get(name)?.state !== 'failed') setState(name, 'starting');
    try {
      const h = await starters[name]();
      handles.set(name, h);
      sigs.set(name, sig);
      setState(name, 'running');
      onApplied(name);
      log.log(`[main] ${name} started`);
    } catch (err) {
      const error = oneLine(err);
      const was = states.get(name);
      setState(name, 'failed', error);
      // Retried on every load; the same reason is printed once, a new one again.
      if (!(was?.state === 'failed' && was.error === error)) log.error(`[main] ${name} failed to start: ${error}`);
    }
  }

  async function pass(why) {
    if (closed) return;
    const platforms = choose();
    wanted = platforms.enabled.slice();
    const sigOf = (name) => platforms.signatures?.[name] ?? '';
    // The choice line on the first pass and whenever it changes — not on every 5-minute re-read.
    if (platforms.note !== lastNote) {
      lastNote = platforms.note;
      log[platforms.unknown.length ? 'warn' : 'log'](`[main] ${platforms.note}${why ? ` (${why})` : ''}`);
    }
    for (const name of [...handles.keys()]) {
      if (!wanted.includes(name)) {
        await stopOne(name, 'switched off in the settings');
        setState(name, 'off');
      }
    }
    for (const name of Object.keys(starters)) {
      if (!wanted.includes(name) && !handles.has(name)) setState(name, 'off');
    }
    for (const name of wanted) {
      if (closed) return;
      if (handles.has(name)) {
        if (sigs.get(name) === sigOf(name)) continue;
        await stopOne(name, 'its settings changed');
      }
      await startOne(name, sigOf(name));
    }
  }

  return {
    /** Bring the readers in line with the settings. Resolves when this pass is done. */
    reconcile(why = '') {
      queue = queue.then(() => pass(why)).catch((e) => log.error(`[main] platform start: ${oneLine(e)}`));
      return queue;
    },
    /** Resolves once every pass asked for so far has finished. */
    settled: () => queue,
    /** The running reader's handle, or null. */
    handle: (name) => handles.get(name) ?? null,
    /** Every running reader's names, in start order. */
    names: () => [...handles.keys()],
    /** Did the last pass choose this platform? */
    wanted: (name) => wanted.includes(name),
    /**
     * Every platform's state. A running reader that can tell (`handle.health()` → { state, error })
     * refines `running` — the Kick reader is `starting` until it has its chatroom, `failed` when it
     * cannot find it.
     * @returns {Record<string, { state: 'off'|'starting'|'running'|'failed', since: string, error: string }>}
     */
    states() {
      const out = {};
      for (const [name, s] of states) {
        let { state, since, error } = s;
        const h = handles.get(name);
        if (state === 'running' && typeof h?.health === 'function') {
          try {
            const r = h.health() || {};
            if (['starting', 'running', 'failed'].includes(r.state)) {
              state = r.state;
              error = r.error ? oneLine(r.error) : '';
              if (Number.isFinite(r.since) && r.since > since) since = r.since;
            }
          } catch (e) { state = 'failed'; error = oneLine(e); }
        }
        out[name] = { state, since: new Date(since).toISOString(), error };
      }
      return out;
    },
    // What is running now — a start still in flight is not waited for, so shutdown never hangs on one.
    async stop() {
      closed = true;
      await Promise.allSettled([...handles.values()].map((h) => h?.stop?.()));
    },
  };
}

/**
 * Boot: the readers the settings name now, and again on EVERY settings load after this — a
 * platform switched on, off or changed later follows without a restart. Subscribes BEFORE the boot
 * pass, so a load that lands while a reader is still starting is not missed.
 * @param {{ platforms: ReturnType<typeof createPlatformStarter>, config: { onLoad: (fn: () => void) => () => void }, bootLoaded: boolean, log?: Pick<Console, 'log'> }} opts
 * @returns {() => void} unsubscribe
 */
export async function startPlatformsWhenLoaded({ platforms, config, bootLoaded, log = console }) {
  if (!bootLoaded) log.log('[main] settings not loaded yet — the platforms they name start when they arrive');
  const off = config.onLoad(() => { platforms.reconcile('settings loaded'); });
  await platforms.reconcile();
  return off;
}
