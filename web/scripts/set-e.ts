// Set E (currency per stream) and re-render every store price against it.
//
//   DATABASE_URL=… node --experimental-strip-types scripts/set-e.ts 50
//   DATABASE_URL=… node --experimental-strip-types scripts/set-e.ts 50 --apply
//
// Without --apply this is a DRY RUN: it prints exactly what would move and
// writes nothing. The preview and the write share one pure planner
// (planRecompute), so the dry run cannot disagree with the write it previews —
// which is the whole point of a dry run on something that changes what people
// are charged.
//
// WHY THIS EXISTS AND WHY IT IS THE ONLY WAY IN. Prices are a STORED column
// (site.store_prices.price); `e_value` is only the anchor they are rendered
// from. So
//
//     UPDATE site.store_price_state SET e_value = 50;   -- moves NOTHING
//
// changes what /api/store/prices reports as `e` and leaves every price exactly
// where it was. The recompute is what rewrites them, and it is deliberately not
// scheduled: E is a measurement of participation earning, and floating prices
// on a number nobody has measured is worse than not floating them at all. A
// human runs this.
//
// DAMPING MEANS ONE RUN IS NOT THE DESTINATION. Each recompute may move a
// price by at most ±10%, so a large change in E takes several runs across
// several streams to land — by design, so one quiet stream cannot crater the
// store. The dry run shows the NEXT step, not the final price.
import { storePricing } from "../app/lib/storePricingServer.ts";
import pool from "../lib/db.ts";
import { publishInstallValues } from "../app/lib/installValuesServer.ts";
import { currencyName } from "../app/lib/currency.ts";

// The install's own currency word for the usage line (its CURRENCY_* values; unset = neutral).
publishInstallValues();

const e = Number(process.argv[2]);
const apply = process.argv.includes("--apply");

if (!Number.isFinite(e) || e <= 0) {
  console.error(`usage: set-e.ts <E> [--apply]      (E is ${currencyName()} per stream, positive)`);
  process.exit(2);
}

function table(rows: Array<{ itemKey: string; from: number; to: number }>): void {
  const w = Math.max(...rows.map((r) => r.itemKey.length));
  for (const r of rows) {
    const arrow = r.to > r.from ? "↑" : "↓";
    const pct = Math.round(((r.to - r.from) / r.from) * 100);
    console.log(`  ${r.itemKey.padEnd(w)}  ${String(r.from).padStart(6)} ${arrow} ${String(r.to).padStart(6)}  (${pct > 0 ? "+" : ""}${pct}%)`);
  }
}

const current = await storePricing.getE();
console.log(`\nE: ${current} → ${e}\n`);

if (apply) {
  const changed = await storePricing.recomputeStorePrices(e);
  if (changed.length === 0) {
    console.log("  no price moved (E is recorded either way, so the run is on the record)");
  } else {
    table(changed);
  }
  console.log(`\nAPPLIED. ${changed.length} price(s) written.`);
  // Anyone with the store open is holding the OLD price. Their next spend
  // gets 409 price_changed and refetches — which is the guard working, not a
  // bug, but it is why a recompute belongs between streams.
  console.log("Clients holding the old price will get 409 price_changed on their next spend.\n");
} else {
  const changes = await storePricing.previewRecompute(e);
  if (changes.length === 0) {
    console.log("  no price would move at this E.\n");
  } else {
    table(changes);
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to commit.`);
    console.log("Damping caps each run at ±10%, so a big change in E needs several runs.\n");
  }
}

await pool.end();
