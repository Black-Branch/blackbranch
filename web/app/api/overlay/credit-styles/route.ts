import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { getBadgeSnapshot } from "@/app/lib/badgeCache";
import { staffMatrixIds } from "@/app/lib/staff";
import { creditStyles, type CreditStyleRow } from "@/app/lib/creditStyles";
import { createSlidingWindowLimiter, ipKey } from "@/app/lib/rateLimit";

// GET /api/overlay/credit-styles?names=a,b,c
//   -> { styles: { [lowerName]: { usernameColor, usernameStyle, badges } } }
//
// The web-served credit overlay (/overlay/credit) renders each sponsor's name
// with the SAME style engine chat uses (usernameStyleCSS + the badge order), and
// this is the one lookup it needs: the sponsorState frame carries names, not
// ids — and the name is the linked site account's display_name whenever there
// is one (sponsors.js resolves each canonical id), so matching on
// site.users.display_name, case-insensitively, finds the account behind a
// platform donation too. A donor with no site account (a Ko-fi name, say)
// simply has no entry and renders plain. Ties on a display name take the
// most recently created account.
//
// Public, read-only, capped at 60 names per call, and it answers with what chat shows next to a
// name — colour, equipped style, the badges chat renders (creditStyles.ts) — never the account's
// Matrix id: a name → account lookup open to anyone would be a directory of the site's members.
// It still answers "does an account with this display name exist?", so it is rate-limited per
// address. Its own budget, not the colours/looks one: the overlay asks once per batch of new
// sponsors, and must not be starved by chat on the same address. Answering only for names in the
// current sponsor pool would close it fully; web cannot read that pool today (stream-api holds it).
const MAX_NAMES = 60;
const LOOKUPS_PER_MIN = 20;
const limited = createSlidingWindowLimiter(60_000, LOOKUPS_PER_MIN);

export async function GET(req: Request): Promise<NextResponse> {
  const raw = new URL(req.url).searchParams.get("names") ?? "";
  // A leading '@' is not part of a name (sponsors.js merges the two spellings
  // and shows the bare one); tolerated here too so an older frame's "@name"
  // still finds the account.
  const names = [...new Set(raw.split(",").map((n) => n.trim().replace(/^@+/, "").toLowerCase()).filter(Boolean))].slice(0, MAX_NAMES);
  if (names.length === 0) return NextResponse.json({ styles: {} });
  if (limited(ipKey(req))) return NextResponse.json({ error: "too_fast" }, { status: 429, headers: { "Retry-After": "10" } });
  const r = await pool.query<CreditStyleRow>(
    `SELECT DISTINCT ON (lower(display_name))
            lower(display_name) AS key, matrix_id, username_color, username_style
       FROM site.users
      WHERE lower(display_name) = ANY($1::text[]) AND NOT COALESCE(is_bot, false) AND deleted_at IS NULL
      ORDER BY lower(display_name), created_at DESC`,
    [names],
  );
  const styles = creditStyles(r.rows, await getBadgeSnapshot(), staffMatrixIds());
  return NextResponse.json({ styles }, { headers: { "Cache-Control": "no-store" } });
}
