// Body clamps for the support write routes. Pure, so the caps are testable
// without spinning up routes; both routes sanitize AFTER clamping (sanitize
// lives with the route — it pulls in server-only imports).

export type TicketBody = {
  kind: "bug" | "other";
  body: string;
  transcript: { role: "bot" | "user"; text: string }[] | null;
};

export type ReportBody = { username: string; reason: string };

const BODY_MAX = 2000;
const REASON_MAX = 500;
const USERNAME_MAX = 80;
const TRANSCRIPT_MSGS = 40;
const TRANSCRIPT_TEXT = 500;

export function clampTicket(raw: unknown): TicketBody | null {
  const b = raw as { kind?: unknown; body?: unknown; transcript?: unknown } | null;
  const kind = b?.kind;
  if (kind !== "bug" && kind !== "other") return null;
  const body = typeof b?.body === "string" ? b.body.trim().slice(0, BODY_MAX) : "";
  if (!body) return null;
  // Malformed rows drop FIRST, then the window — slicing first would let one
  // junk row displace a real message out of the kept 40.
  const transcript = Array.isArray(b?.transcript)
    ? b.transcript.flatMap((m) => {
        const t = m as { role?: unknown; text?: unknown } | null;
        const role = transcriptRole(t?.role);
        if (role === null || typeof t?.text !== "string") return [];
        return [{ role, text: t.text.slice(0, TRANSCRIPT_TEXT) }];
      }).slice(-TRANSCRIPT_MSGS)
    : null;
  return { kind, body, transcript: transcript?.length ? transcript : null };
}

export function clampReport(raw: unknown): ReportBody | null {
  const b = raw as { username?: unknown; reason?: unknown } | null;
  const username = typeof b?.username === "string" ? b.username.trim().slice(0, USERNAME_MAX) : "";
  const reason = typeof b?.reason === "string" ? b.reason.trim().slice(0, REASON_MAX) : "";
  if (!username || !reason) return null;
  return { username, reason };
}

/** A support-panel message's speaker: "user", or "bot" for the desk's own lines. Anything else: null. */
export function transcriptRole(role: unknown): "bot" | "user" | null {
  if (role === "user") return "user";
  if (role === "bot") return "bot";
  return null;
}
