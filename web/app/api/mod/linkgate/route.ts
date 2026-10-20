import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { appendModLog } from "@/app/lib/modlog";
import { refreshBlocklistOverrides } from "@/app/lib/blocklistOverrides";
import { gateLinks, currentHostRules, type LinkPosture } from "@/app/lib/linkGate";

// The link gate's posture lever, a sibling of the min_account_age lockdown
// lever and stored in the same single row.
//
// `off` IS THE DEFAULT AND THE SAFE STATE. This gate is allowlist-based, so
// arming it with an empty allowlist holds every link in chat. `flag` exists so
// the blast radius can be MEASURED on a real stream first — "how much of our
// chat is links to hosts nobody has allowlisted" is not answerable from a code
// review, and finding out by holding all of it is the wrong way.

const POSTURES: LinkPosture[] = ["off", "flag", "hold"];

export async function GET() {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const { rows } = await pool.query<{ link_gate: string }>(
    `SELECT link_gate FROM site.lockdown WHERE id = 1`
  );
  const { rows: hosts } = await pool.query<{ severity: number }>(
    `SELECT severity FROM site.blocklist_overrides WHERE kind = 'host'`
  );

  return Response.json({
    posture: rows[0]?.link_gate ?? "off",
    allowlisted: hosts.filter((h) => h.severity === 1).length,
    held: hosts.filter((h) => h.severity >= 2).length,
  });
}

export async function POST(req: Request) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = (await req.json().catch(() => ({}))) as { posture?: unknown; sample?: unknown };

  // A dry run: judge a sample line against the CURRENT rules without changing
  // anything. The honest way to answer "what would arming this do to my chat".
  if (typeof body.sample === "string") {
    const v = gateLinks({ text: body.sample, posture: "hold", rules: currentHostRules() });
    return Response.json({
      wouldHold: v.action === "hold",
      host: v.action === "hold" ? v.host : null,
      reason: v.action === "hold" ? v.reason : null,
    });
  }

  const posture = String(body.posture ?? "");
  if (!POSTURES.includes(posture as LinkPosture)) {
    return Response.json(
      { error: `Posture must be off, flag or hold. Got "${posture}".` },
      { status: 400 }
    );
  }

  await pool.query(`UPDATE site.lockdown SET link_gate = $1, updated_by = $2, updated_at = now() WHERE id = 1`,
    [posture, mod]);

  // Apply here at once; stream-api follows on its own 60s cycle.
  await refreshBlocklistOverrides();

  await appendModLog({
    action: posture === "off" ? "link_gate_disabled" : "link_gate_enabled",
    target: "site",
    by: mod,
    reason: `link gate → ${posture}`,
  });

  return Response.json({ ok: true, posture });
}
