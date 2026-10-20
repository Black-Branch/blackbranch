import { NextRequest } from "next/server";
import { resolveIdentities, getSocialCredit } from "@/lib/socialCredit";
import { parsePublicId } from "@/app/lib/publicIdServer";
import { isNativePlatform } from "@/app/lib/nativePlatform";
import { linkFacts, viewerFacts } from "@/app/lib/linkFactsServer";
import { ERASED_CANONICAL } from "@/app/lib/erasedPerson";

// GET /api/user/credit?id=<public id | @matrix id>
// Public read — a person's social credit total for the card.
//
// The total summed across EVERY identity linked to the person would be the same number on their
// Twitch card and their YouTube card — the cross-platform link, published as surely as an id
// (owner decision 2026-10-17). So the merged total is for the person, a moderator, or once the
// person shows their links (linkFactsServer.ts — the same facts the profile card decides on).
// Anyone else gets the credit of the ONE identity asked about: a platform identity's votes on that
// platform's lines, or a site account's own (site chat + forum).
//
// The `matrixId=` + `canonicalId=` params are the LIVE path for a viewer's OWN card
// (profileCardPrefetch.ts asks with them) — not leftovers. `matrixId=` reads as an id; a raw
// `canonicalId=` is answered only for a moderator or the person.
const MATRIX_RE = /^@[^\s:]+:[A-Za-z0-9.-]+$/;
const CANONICAL_RE = /^[a-f0-9]{1,32}$/i;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const id = sp.get("id") ?? sp.get("matrixId");
  const rawCanonical = sp.get("canonicalId");

  const pub = id ? parsePublicId(id) : null;
  const matrixKey = id && !pub && MATRIX_RE.test(id) ? id : null;
  const legacyCanonical = !pub && !matrixKey && rawCanonical && CANONICAL_RE.test(rawCanonical) ? rawCanonical : null;
  const canonical = pub?.canonical ?? legacyCanonical;
  if (!pub && !matrixKey && !legacyCanonical) return new Response("Bad Request", { status: 400 });
  if (canonical === ERASED_CANONICAL) return Response.json({ credit: 0 });

  try {
    const { viewer, isMod, isSelf } = await viewerFacts(canonical, matrixKey);
    if (legacyCanonical && !isMod && !isSelf) return Response.json({ credit: 0 });
    // The person's own card counts from THEIR account, never another account sharing the canonical.
    const { owner } = await linkFacts(canonical, matrixKey, isSelf ? viewer : null);
    const full = isMod || isSelf || owner?.show_links === true;
    if (full) {
      const ids = await resolveIdentities({ matrixId: matrixKey ?? owner?.matrix_id ?? null, canonicalId: canonical });
      return Response.json({ credit: await getSocialCredit(ids) });
    }
    if (pub && !isNativePlatform(pub.platform)) {
      return Response.json({ credit: await getSocialCredit({ matrixIds: [], canonicalIds: [pub.canonical] }, pub.platform) });
    }
    const site = matrixKey ?? owner?.matrix_id ?? null;
    return Response.json({ credit: site ? await getSocialCredit({ matrixIds: [site], canonicalIds: [] }) : 0 });
  } catch {
    return Response.json({ credit: 0 });
  }
}
