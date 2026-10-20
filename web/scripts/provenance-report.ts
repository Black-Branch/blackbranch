// How much of the currency in circulation is backed by real money?
//
//   DATABASE_URL=… node --experimental-strip-types scripts/provenance-report.ts
//
// READ-ONLY. Prints the community picture under all three drain policies side
// by side, because the policy is a CHOICE and the honest way to make it is to
// see the spread it produces on real data rather than to reason about it.
//
// The three policies and what they mean are documented on `DrainPolicy` in
// app/lib/coinProvenance.ts. In one line each: pro-rata drains every pool
// proportionally (recommended — ungameable by timing), earned-first is
// conservative (over-states money backing), purchased-first is generous and
// gameable (buy, spend, look clean).
import { attributeAllWallets } from "../app/lib/coinProvenanceServer.ts";
import {
  DRAIN_POLICIES, PRODUCT_DRAIN, PROVENANCE_BUCKETS, isHouseWallet, moneyBacked, splitTotal,
  type DrainPolicyFor, type Split,
} from "../app/lib/coinProvenance.ts";
import pool from "../lib/db.ts";
import { publishInstallValues } from "../app/lib/installValuesServer.ts";
import { currencyName, currencyTitle } from "../app/lib/currency.ts";

// The install's own currency word (its CURRENCY_* values, as the site reads them at start; unset =
// the product's neutral word) — the report names amounts the way the site does.
publishInstallValues();
const cur = currencyName();

const n = (v: number) => v.toLocaleString("en-US");
const pct = (part: number, whole: number) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`);

function sumSplits(splits: Split[]): Split {
  const out: Split = { purchased: 0, earned: 0, granted: 0, winnings: 0 };
  for (const s of splits) for (const b of PROVENANCE_BUCKETS) out[b] += s[b];
  return out;
}

async function reportPolicy(policy: DrainPolicyFor, label = String(policy)) {
  const all = await attributeAllWallets(policy);
  // OWNER WALLETS ARE NOT CIRCULATION. A grant exists to make the cost of
  // store items and stickers meaningless for the people who run the site — it
  // is an exemption from cost, not value in the economy. A "total in
  // circulation" that includes the grants describes nothing, and every ratio
  // computed against it rounds to 0.0%.
  const house = all.filter(isHouseWallet);
  const wallets = all.filter((w) => !isHouseWallet(w));

  const circulating = sumSplits(wallets.map((w) => w.split));
  const atRisk = sumSplits(wallets.map((w) => w.atRiskInMarkets));
  const total = splitTotal(circulating);

  console.log(`\n━━ ${label} ${"━".repeat(Math.max(0, 58 - label.length))}`);
  console.log(`   IN CIRCULATION: ${n(total)} ${cur} across ${wallets.length} participant wallets`);
  for (const b of PROVENANCE_BUCKETS) {
    if (circulating[b] === 0) continue;
    console.log(`     ${b.padEnd(10)} ${n(circulating[b]).padStart(10)}  ${pct(circulating[b], total).padStart(7)}`);
  }
  console.log(`   BACKED BY REAL MONEY: ${n(moneyBacked(circulating))} ${cur}`
    + ` (${pct(moneyBacked(circulating), total)} of circulation)`);
  console.log(`   at risk in markets (historical — every market is settled): ${n(splitTotal(atRisk))} ${cur}`
    + ` (of which money-backed: ${n(moneyBacked(atRisk))})`);

  // Named, never just netted out — a wallet misclassified as an owner by a
  // corrective admin_adjust has to be visible here rather than silently
  // removed from every total above. See isHouseWallet's KNOWN LIMIT note.
  console.log(`   excluded as owner wallets (granted, so cost does not apply to them):`);
  for (const w of house.sort((a, b) => b.balance - a.balance)) {
    console.log(`     ${w.matrixId.padEnd(32)} holds ${n(w.balance).padStart(10)}`
      + ` · granted ${n(w.grantsReceived)} · earned ${n(w.split.earned)}`);
  }

  // The distribution matters more than the total for any per-user rule: a
  // policy that leaves the community 90% clean in aggregate can still leave the
  // ten people who traded holding purchased currency.
  const withMoney = wallets.filter((w) => w.split.purchased > 0);
  console.log(`   participants holding ANY purchased ${cur}: ${withMoney.length} of ${wallets.length}`);
  const top = [...withMoney].sort((a, b) => b.split.purchased - a.split.purchased).slice(0, 5);
  for (const w of top) {
    console.log(`     ${w.matrixId.padEnd(32)} ${n(w.split.purchased).padStart(8)} purchased`
      + ` of ${n(w.balance)} (${pct(w.split.purchased, w.balance)})`);
  }
}

async function main() {
  console.log(`${currencyTitle()} provenance — how much of the balance is backed by real money?`);
  console.log("READ-ONLY. Nothing here writes to the database.");
  // PRODUCT_DRAIN FIRST, because it is the only one that describes the
  // system as shipped. Printing only the three UNIFORM policies would make the
  // headline "money-backed at risk in open markets" report a number under a
  // policy the product does not use, while the real answer under the shipped
  // policy is 0. A report that no longer describes the system is worse than no
  // report: it is a number somebody will quote.
  //
  // The three uniform policies stay BELOW it, because the choice between them
  // is still the thing this file was written to inform (see DrainPolicy) and
  // seeing the spread on real data is how that choice stays honest.
  await reportPolicy(PRODUCT_DRAIN, "PRODUCT (as shipped)");
  for (const policy of DRAIN_POLICIES) await reportPolicy(policy);
  console.log("");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
