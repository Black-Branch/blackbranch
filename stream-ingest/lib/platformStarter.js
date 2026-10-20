// The platform chat readers: which ones run, started once each.
//
// The choice (lib/platformsEnv.js) reads the settings, so it is only as good as the settings
// this process has. When the boot load from stream-api fails, the boot choice is made from env +
// defaults — on an install whose channels are stored in the database that is nothing at all. So
// the choice is made again when the settings first arrive, and every reader it names that is not
// running is started then. That second pass happens once: the channel keys are applied at restart
// (reload: 'restart' in the schema), and a later load — a reconnect, a config_changed frame, the
// 5-minute backstop — must never start a second copy of a reader that is already running.
//
// A reader whose start threw has no handle, so the recovery pass tries it again (the Kick reader
// throws while its channel is unknown). Passes are serialised: a load that lands while the boot
// pass is still starting a reader waits for it rather than starting that reader a second time.

/**
 * @param {{
 *   starters: Record<string, () => Promise<object>>,
 *   choose: () => { enabled: string[], unknown: string[], note: string },
 *   log?: Pick<Console, 'log'|'warn'|'error'>,
 * }} opts
 */
export function createPlatformStarter({ starters, choose, log = console }) {
  const handles = new Map(); // name → the started reader's handle
  let queue = Promise.resolve();

  async function pass(why) {
    const platforms = choose();
    log[platforms.unknown.length ? 'warn' : 'log'](`[main] ${platforms.note}${why ? ` (${why})` : ''}`);
    for (const name of platforms.enabled) {
      if (handles.has(name)) continue;
      try {
        handles.set(name, await starters[name]());
        log.log(`[main] ${name} started`);
      } catch (err) {
        // tmi.js rejects with a bare string, which has no `.message`.
        log.error(`[main] ${name} failed to start:`, err?.message || String(err));
      }
    }
  }

  return {
    /** Start every chosen reader that is not running. Resolves when this pass is done. */
    reconcile(why = '') {
      queue = queue.then(() => pass(why)).catch((e) => log.error(`[main] platform start: ${e.message}`));
      return queue;
    },
    /** Resolves once every pass asked for so far has finished. */
    settled: () => queue,
    /** The running reader's handle, or null. */
    handle: (name) => handles.get(name) ?? null,
    /** Every running reader's names, in start order. */
    names: () => [...handles.keys()],
    // What is running now — a start still in flight is not waited for, so shutdown never hangs on one.
    async stop() {
      await Promise.allSettled([...handles.values()].map((h) => h?.stop?.()));
    },
  };
}

/**
 * Boot: the readers the settings name now, and — when the boot load failed — again on the first
 * load that succeeds. Subscribes BEFORE the boot pass, so a load that lands while a reader is
 * still starting is not missed.
 * @param {{ platforms: ReturnType<typeof createPlatformStarter>, config: { onLoad: (fn: () => void) => () => void }, bootLoaded: boolean, log?: Pick<Console, 'log'> }} opts
 */
export async function startPlatformsWhenLoaded({ platforms, config, bootLoaded, log = console }) {
  if (!bootLoaded) {
    log.log('[main] settings not loaded yet — the platforms they name start when they arrive');
    const off = config.onLoad(() => {
      off();
      platforms.reconcile('settings loaded');
    });
  }
  await platforms.reconcile();
}
