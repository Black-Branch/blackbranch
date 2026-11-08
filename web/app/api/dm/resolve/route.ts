import pool from "@/lib/db";
import { auth } from "@/auth";
import { NextRequest } from "next/server";
import { ACTIVE_BAN_SQL, DM_BANNED } from "@/app/lib/dm/banGate";
import { resolvePeople, type PeopleQuery } from "@/app/lib/dm/resolvePeople";
import { feedEnv } from "@/app/lib/community/desiredServer";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import { matrixServerName } from "@/app/lib/matrixConfig";

// GET ?q=<name> — the site accounts a typed name can mean, for `/dm <name>`, its completion and
// the DM list's "+": every account, by username or display name, anywhere in either
// (lib/dm/resolvePeople.ts). Signed-in only; a DM-banned account is refused; 60 lookups a minute per
// account (the completion asks once per pause in typing): the account list is not for walking.

const perUser = createSlidingWindowLimiter(60_000, 60);

/** The install's own accounts (the community service account, the forum reader): never a person to
 *  message. Unresolvable settings hide nothing rather than fail the lookup. */
function installAccounts(): string[] {
  try {
    const env = feedEnv();
    return [env.serviceUserId, ...(env.readerUserId ? [env.readerUserId] : [])];
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const session = await auth().catch(() => null);
  const me = session?.user?.id;
  if (!me) return Response.json({ error: "Sign in first." }, { status: 401 });
  const { rows: ban } = await pool.query(ACTIVE_BAN_SQL, [me]).catch(() => ({ rows: [] as unknown[] }));
  if (ban.length) return Response.json({ error: DM_BANNED }, { status: 403 });
  if (perUser(me)) return Response.json({ error: "slow down" }, { status: 429 });

  const query: PeopleQuery = (sql, params) => pool.query(sql, params);
  const answer = await resolvePeople(query, req.nextUrl.searchParams.get("q") ?? "", me, installAccounts(), matrixServerName())
    .catch(() => ({ people: [], exact: false }));
  return Response.json(answer);
}
