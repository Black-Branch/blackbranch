import { requireUser } from "@/app/lib/authGuard";
import { loadGiftLedger } from "@/app/lib/giftLedgerServer";

export const runtime = "nodejs";

// GET /api/billing/gifts → { given: GiftPurchaseView[], received: GiftReceivedView[] }
//
// The gifter's ledger: every gift the caller has paid for, grouped per
// purchase with who got it, until when, and how many community slots are
// still waiting for a new member — plus every gift they received.
// Read-only; the billing webhook is the only writer of gift state.
// Auth-gated: the ledger is the caller's own money.
export async function GET() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  return Response.json(await loadGiftLedger(matrixId));
}
