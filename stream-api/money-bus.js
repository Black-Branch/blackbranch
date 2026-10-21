// The money bus: who hears about a contribution after the support bar has banked it.
//
// The support bar's `onAdd` IS `publish` — the bar banks the money, broadcasts its frame and
// credits the timer first (supportbar.js's ORDER invariant), and only then tells the listeners.
// A listener is anything that can be absent: the sponsor credit pool (core), or a site plugin's
// module that subscribes only when switched on (e.g. a funding meter).
//
// Each subscriber is guarded on its own, synchronous throw AND rejected promise, so one
// listener's failure can never cost another's — or reach the money route that published.

'use strict';

function createMoneyBus({ log = console } = {}) {
  const subscribers = [];

  /** Add a listener. `name` labels its failures in the journal. Returns an unsubscribe. */
  function subscribe(name, fn) {
    const sub = { name, fn };
    subscribers.push(sub);
    return () => { const i = subscribers.indexOf(sub); if (i >= 0) subscribers.splice(i, 1); };
  }

  /** Hand one contribution payload to every listener, in subscription order. Never throws. */
  function publish(payload) {
    for (const { name, fn } of [...subscribers]) {
      try {
        const r = fn(payload);
        if (r && typeof r.catch === 'function') r.catch((e) => log.warn(`[money-bus] ${name}: ${e && e.message}`));
      } catch (e) { log.warn(`[money-bus] ${name}: ${e && e.message}`); }
    }
  }

  return { subscribe, publish, size: () => subscribers.length };
}

/** The sponsor pool's subscription — the journal line it always had. */
function subscribeSponsors(bus, sponsors) {
  return bus.subscribe('sponsors', (payload) => {
    try { sponsors.ingest(payload); } catch (e) { console.warn('[sponsors] ingest:', e.message); }
  });
}

module.exports = { createMoneyBus, subscribeSponsors };
