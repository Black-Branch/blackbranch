import { getBalance } from "@/app/lib/coinsServer";
import { attributeWallet } from "@/app/lib/coinProvenanceServer";
import { earnedBalance, PRODUCT_DRAIN } from "@/app/lib/coinProvenance";
import { requireUser } from "@/app/lib/authGuard";

export const runtime = "nodejs";

// GET /api/points/balance → { balance, earned }
// The signed-in user's own wallet balance (coins == cents). Uncached on purpose:
// the wallet chip and spend UIs must never lie (see coinsServer.ts).
//
// `earned` is how much of that balance was EARNED rather than bought — the
// parenthetical beside the total ("1,475q (475q)"): earned + legacy winnings,
// never the purchased or granted pools. Every consumer reads `balance`, so the
// field is additive.
//
// The split is derived from the ledger on read rather than stored, which is a
// deliberate choice this endpoint has to honour — see coinProvenanceServer.ts's
// header. It costs one indexed read of the caller's own rows, and it can never
// disagree with the ledger it is computed from.
export async function GET() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const balance = await getBalance(matrixId);
  // Degrade to `balance` rather than failing the request. This endpoint feeds
  // the wallet chip on every mount and focus, and a fold that threw would blank
  // the viewer's whole balance over a number that is only ever a parenthetical.
  // Over-reporting is the right direction to fail in: nothing is enforced on
  // this number anywhere — it is display, and a wrong parenthetical for one
  // request is cheaper than a blank total.
  const earned = await attributeWallet(matrixId, PRODUCT_DRAIN)
    .then((a) => earnedBalance(a.split))
    .catch(() => balance);

  return Response.json({ balance, earned });
}
