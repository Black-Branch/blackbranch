import { storePricing } from "@/app/lib/storePricingServer";
import { instanceResolve, instanceBool } from "@/app/lib/instanceConfigServer";
import { earnRulesFrom } from "@/app/lib/earnRules";

export const runtime = "nodejs";

// force-dynamic because this is a price. A route handler that Next decided
// to prerender would serve whatever the table said at build time, and every
// buy would then hit the expectedPrice guard with a number the viewer could
// never have been shown.
export const dynamic = "force-dynamic";

// Public: prices are public information and the store renders for guests.
//
// `e` (points per stream) rides along so the client can render "≈ N streams"
// without a second round trip. It is the anchor every price derives from.
// `purchasable` and `clockMultiplier` ride along too: the
// Store hides its top-up box when buying is off, and the sponsor clock's
// tooltip states the real multiplier. Both are public facts about the store.
export async function GET() {
  const [prices, e] = await Promise.all([
    storePricing.getStorePrices(),
    storePricing.getE(),
  ]);
  const purchasable = instanceBool("currency.purchasable");
  const { clockMultiplier } = earnRulesFrom((key) => instanceResolve(key).value);
  return Response.json({ prices, e, purchasable, clockMultiplier });
}
