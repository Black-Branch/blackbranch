// The module supervisor.
//
// A product module that runs a loop or a listener (the help desk, the chat bot) is started and
// stopped HERE, from its settings, with no restart: on every settings load (a `config_changed`
// frame, a reconnect, the backstop re-read) and on a 30 s tick, each module's `wanted()` is read.
// Wanted and not running → start it once. Running and not wanted → stop it (a loop finishes its
// current turn first). A module's start returns its stop function.

const TICK_MS = 30_000;

/**
 * @param {{ name: string, wanted: () => boolean, start: () => (() => (void|Promise<void>)) }[]} modules
 * @param {{ onLoad?: (fn: () => void) => () => void, log?: Pick<Console, 'log'|'warn'>, tickMs?: number }} [opts]
 */
export function createSupervisor(modules, { onLoad = null, log = console, tickMs = TICK_MS } = {}) {
  const running = new Map();   // name → stop()
  let closed = false;

  function reconcile() {
    if (closed) return;
    for (const m of modules) {
      let want = false;
      try { want = m.wanted() === true; } catch (e) { log.warn(`[supervisor] ${m.name}: wanted() threw: ${e.message} — treated as off`); }
      const on = running.has(m.name);
      if (want && !on) {
        try {
          running.set(m.name, m.start());
          log.log(`[supervisor] ${m.name} started`);
        } catch (e) { log.warn(`[supervisor] ${m.name} failed to start: ${e.message}`); }
      } else if (!want && on) {
        const stop = running.get(m.name);
        running.delete(m.name);
        Promise.resolve().then(() => stop && stop()).catch((e) => log.warn(`[supervisor] ${m.name} stop: ${e.message}`));
        log.log(`[supervisor] ${m.name} stopped (switched off)`);
      }
    }
  }

  const offLoad = onLoad ? onLoad(reconcile) : null;
  const timer = setInterval(reconcile, tickMs);
  timer.unref?.();
  reconcile();

  return {
    reconcile,
    isRunning: (name) => running.has(name),
    async stop() {
      closed = true;
      clearInterval(timer);
      if (offLoad) offLoad();
      const stops = [...running.values()];
      running.clear();
      await Promise.allSettled(stops.map((s) => Promise.resolve().then(() => s && s())));
    },
  };
}
