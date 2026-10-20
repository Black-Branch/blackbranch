import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { appendModLog } from "@/app/lib/modlog";
import { normalizeTerm, BLOCKLIST, actionFor, type Severity } from "@/app/lib/blacklist";
import { normalizeHost, judgeHost, currentHostRules } from "@/app/lib/linkGate";
import { refreshBlocklistOverrides } from "@/app/lib/blocklistOverrides";

// Mod-curated runtime re-grading of blocklist terms.
//
// Drives `/blacklist word` and `/whitelist word`. The severity IS the whole
// mechanism — `actionFor` already maps 1→allow, 2-3→hold, ≥4→block — so there is
// no separate "allowed terms" concept to keep in sync.
//
// SEVERITY 4 IS REFUSED HERE **AND** BY A DB CHECK. Two layers on purpose:
// turning on message DESTRUCTION from a chat command is the one thing this
// feature must never make easy, and a handler check alone is one forgetful
// caller away from being bypassed. The check below exists to give a good error
// message; the constraint is what actually guarantees it.

/** The ceiling for a runtime override. Above this is a code-level decision. */
const MAX_RUNTIME_SEVERITY = 3;

type Row = { kind: string; term: string; severity: number; set_by: string; set_at: string; note: string | null };

export async function GET() {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const { rows } = await pool.query<Row>(
    `SELECT kind, term, severity, set_by, set_at, note
       FROM site.blocklist_overrides ORDER BY kind, term`
  );

  // The shipped grading is included so the list can say what each override
  // CHANGED. "twink: 1" alone doesn't tell a mod whether they fixed something or
  // added a term nobody had listed.
  const shipped = new Map(BLOCKLIST.map((e) => [normalizeTerm(e.term), e.severity]));

  return Response.json({
    overrides: rows.map((r) => {
      // Only WORD rules have a shipped grading to have changed — a host rule is
      // always new, because the shipped list has no hosts in it.
      const was = r.kind === "word" ? shipped.get(normalizeTerm(r.term)) ?? null : null;
      return {
        kind: r.kind,
        term: r.term,
        severity: r.severity,
        action: actionFor(r.severity as Severity),
        shippedSeverity: was,
        shippedAction: was === null ? null : actionFor(was as Severity),
        isNewTerm: was === null,
        setBy: r.set_by,
        setAt: r.set_at,
        note: r.note,
      };
    }),
  });
}

export async function POST(req: Request) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = (await req.json().catch(() => ({}))) as {
    term?: unknown; severity?: unknown; note?: unknown; kind?: unknown;
  };

  // Two normalisers, not one. Word terms are reduced to LETTERS (so "tw.ink"
  // keys as "twink", matching how the matcher works); a host must keep its dots
  // or "example.com" becomes "examplecom" and can never match anything. This is
  // the whole reason the table has a `kind` discriminator instead of one flat list.
  const kind = body.kind === "host" ? "host" : "word";
  const raw = String(body.term ?? "");
  const term = kind === "host" ? normalizeHost(raw) : normalizeTerm(raw);
  if (!term) {
    return Response.json(
      {
        error: kind === "host"
          ? `"${raw}" is not a hostname — give something like example.com.`
          : "Give a term made of letters — the matcher ignores everything else.",
      },
      { status: 400 }
    );
  }
  // Same floor the shipped list uses. Short terms are false-positive machines
  // ("ass" inside "assassin" is the classic), and the matcher's letter-boundary
  // lookaround does not save you from a two-letter term.
  if (kind === "word" && term.length < 3) {
    return Response.json(
      { error: `"${term}" is too short — 3 letters minimum, or it will match inside ordinary words.` },
      { status: 400 }
    );
  }

  const severity = Number(body.severity);
  if (!Number.isInteger(severity) || severity < 1 || severity > MAX_RUNTIME_SEVERITY) {
    return Response.json(
      {
        error:
          severity >= 4
            ? "Severity 4 means the message is DESTROYED, never held for review — that stays a " +
              "code-level decision, not a chat command. Use 3 to hold it for a mod instead."
            : `Severity must be 1 (allow), 2 or 3 (hold). Got ${body.severity}.`,
      },
      { status: 400 }
    );
  }

  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 300) : null;

  await pool.query(
    `INSERT INTO site.blocklist_overrides (kind, term, severity, set_by, note)
     VALUES ($5, $1, $2, $3, $4)
     ON CONFLICT (kind, term) DO UPDATE
       SET severity = EXCLUDED.severity, set_by = EXCLUDED.set_by,
           set_at = now(), note = EXCLUDED.note`,
    [term, severity, mod, note, kind]
  );

  // Apply in THIS runtime at once. stream-api picks it up on its own 60s cycle —
  // the two processes cannot share the cache, and a mod who just typed the
  // command should not watch their own site keep refusing the word.
  await refreshBlocklistOverrides();

  await appendModLog({
    action: "blocklist_override_set",
    target: term,
    by: mod,
    reason: `${kind} · severity ${severity} (${actionFor(severity as Severity)})${note ? ` — ${note}` : ""}`,
  });

  return Response.json({ ok: true, kind, term, severity, action: actionFor(severity as Severity) });
}

export async function DELETE(req: Request) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = (await req.json().catch(() => ({}))) as { term?: unknown; kind?: unknown };
  const raw = String(body.term ?? "");

  // `/whitelist clear` sends no kind — and a mod clearing "x.com" means the
  // HOST rule, while "twink" means the word. Rather than making them spell a
  // kind chat has no syntax for, an unspecified kind clears whichever override
  // the term actually names (both normalisers run; a word key is letters-only,
  // a host key keeps its dots, so at most one row of each can match).
  const wanted: Array<{ kind: "word" | "host"; term: string }> = [];
  if (body.kind === "host" || body.kind === undefined) {
    const h = normalizeHost(raw);
    if (h) wanted.push({ kind: "host", term: h });
  }
  if (body.kind === "word" || body.kind === undefined) {
    const w = normalizeTerm(raw);
    if (w) wanted.push({ kind: "word", term: w });
  }
  if (wanted.length === 0) return Response.json({ error: "Which term?" }, { status: 400 });

  let cleared: { kind: "word" | "host"; term: string } | null = null;
  for (const c of wanted) {
    const { rowCount } = await pool.query(
      `DELETE FROM site.blocklist_overrides WHERE kind = $2 AND term = $1`, [c.term, c.kind]
    );
    if (rowCount) { cleared = c; break; }
  }
  if (!cleared) {
    return Response.json(
      { error: `"${wanted[0]!.term}" has no override to clear.` }, { status: 404 });
  }

  await refreshBlocklistOverrides();
  await appendModLog({ action: "blocklist_override_cleared", target: cleared.term, by: mod });

  // Say what it went BACK to, not just that it cleared — the shipped grading is
  // the thing the mod now has to live with, and for a severity-4 term that means
  // messages start being destroyed again.
  if (cleared.kind === "word") {
    const shipped = BLOCKLIST.find((e) => normalizeTerm(e.term) === cleared!.term);
    return Response.json({
      ok: true,
      kind: "word",
      term: cleared.term,
      restoredSeverity: shipped?.severity ?? null,
      restoredAction: shipped ? actionFor(shipped.severity) : "allow",
    });
  }
  // A cleared HOST reverts to whatever the gate says with no rule for it —
  // usually "unlisted → held when armed", NOT "allow". The old answer here was
  // a hardcoded "allow", which told a mod deleting an allowlist entry the exact
  // opposite of what they had just done.
  const reason = judgeHost(cleared.term, currentHostRules());
  return Response.json({
    ok: true,
    kind: "host",
    term: cleared.term,
    restoredSeverity: null,
    restoredAction: reason === null ? "allow" : "hold",
    reason,
  });
}
