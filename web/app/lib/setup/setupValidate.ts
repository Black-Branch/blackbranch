// The setup pages' "Your site" and "Points" forms: their fields and the checks a value passes
// before it is staged. Pure. Built display values are named by their .env name (that is what the
// host writes); each is checked against the schema's own rules and, like `blackbranch set`, may not
// hold what .env cannot: $, ", \ or a line break.

import { INSTANCE_KEYS, parseInstanceValue } from "../instanceSchema.generated.mjs";

export type FormField = { name: string; label: string; description: string; required?: boolean; max: number; placeholder?: string };

function fromSchema(name: string, extra: Partial<FormField> = {}): FormField {
  const e = INSTANCE_KEYS.find((k) => k.env[0] === name);
  if (!e) throw new Error(`setup: ${name} is not in the settings schema`);
  return { name, label: e.label, description: e.description, max: e.maxLength ?? 300, ...extra };
}

export const SITE_FIELDS: FormField[] = [
  fromSchema("SITE_NAME", { required: true, max: 80 }),
  fromSchema("SITE_SHORT_NAME"),
  fromSchema("SITE_TAGLINE", { max: 120 }),
  fromSchema("SITE_DESCRIPTION", { max: 300 }),
  fromSchema("LEGAL_OPERATOR", { max: 120 }),
  fromSchema("LEGAL_CONTACT_EMAIL", { max: 120, placeholder: "you@example.org" }),
  fromSchema("LEGAL_GOVERNING_LAW", { max: 120 }),
  fromSchema("LEGAL_EFFECTIVE_DATE", { max: 40, placeholder: "January 1, 2026" }),
  fromSchema("SITE_TIME_ZONE", { placeholder: "Europe/Berlin" }),
  fromSchema("SITE_DATA_SINCE", { placeholder: "2026-01-01" }),
];

export const POINTS_FIELDS: FormField[] = [
  fromSchema("CURRENCY_NAME"),
  fromSchema("CURRENCY_NAME_PLURAL"),
  fromSchema("CURRENCY_SYMBOL"),
  fromSchema("CURRENCY_ICON", { max: 300, placeholder: "/my-icon.webp" }),
  fromSchema("COMMUNITY_SCORE_NAME"),
];

// The two "Your site" values that are settings rows, not built values.
const INSTANCE_FIELDS = new Set(["SITE_TIME_ZONE", "SITE_DATA_SINCE"]);

type Staged = { ok: true; install: Record<string, string> } | { ok: false; error: string };

function check(fields: FormField[], data: Record<string, unknown>): Staged & { raw?: Record<string, string> } {
  const raw: Record<string, string> = {};
  const install: Record<string, string> = {};
  for (const f of fields) {
    const v = data[f.name];
    if (v !== undefined && typeof v !== "string") return { ok: false, error: `${f.label}: text expected` };
    const s = (v ?? "").trim();
    if (f.required && !s) return { ok: false, error: `${f.label} is needed` };
    if (s.length > f.max) return { ok: false, error: `${f.label}: at most ${f.max} characters` };
    if (/[$"\\\x00-\x1f\x7f]/.test(s)) return { ok: false, error: `${f.label} may not contain $, " or \\` };
    if (s) {
      const e = INSTANCE_KEYS.find((k) => k.env[0] === f.name);
      const p = e ? parseInstanceValue(e, s) : { ok: true as const, value: s };
      if (!p.ok) return { ok: false, error: `${f.label}: ${p.error}` };
    }
    raw[f.name] = s;
    if (!INSTANCE_FIELDS.has(f.name)) install[f.name] = s;
  }
  return { ok: true, install, raw };
}

function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

function validDay(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

export function validateSiteStep(data: Record<string, unknown>):
  { ok: true; install: Record<string, string>; timeZone: string | null; dataSince: string | null } | { ok: false; error: string } {
  const r = check(SITE_FIELDS, data);
  if (!r.ok) return r;
  const tz = r.raw!.SITE_TIME_ZONE ?? "", since = r.raw!.SITE_DATA_SINCE ?? "";
  if (tz && !validTimeZone(tz)) return { ok: false, error: `Time zone: "${tz}" is not a time zone name (like Europe/Berlin or America/Chicago)` };
  if (since && !validDay(since)) return { ok: false, error: "Data since: a day as YYYY-MM-DD" };
  const email = r.install.LEGAL_CONTACT_EMAIL ?? "";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Contact e-mail: an e-mail address" };
  return { ok: true, install: r.install, timeZone: tz || null, dataSince: since || null };
}

export function validatePointsStep(data: Record<string, unknown>): Staged {
  const r = check(POINTS_FIELDS, data);
  if (!r.ok) return r;
  const icon = r.install.CURRENCY_ICON ?? "";
  if (icon && !/^(\/[^\s]*|https:\/\/[^\s]+)$/.test(icon)) return { ok: false, error: "Points icon: a path on this site (/my-icon.webp) or an https address" };
  return { ok: true, install: r.install };
}

// ── Community: who can join ──────────────────────────────────────────────────────────────────
// `matrix.registration` (open | closed) is whether anyone may make an account on the bundled
// homeserver's own sign-in pages. Unset reads as closed (install/matrix/render.sh), and sign-up stays
// closed while setup runs whatever it says: Finish's render applies the choice. A fresh install that
// never asked left everyone but the admin locked out while the sign-in page invited them in — so the
// Community step asks, and the Finish page says what was chosen and where it changes.

export type JoinChoice = "open" | "closed";

const keyLabel = (key: string): string => {
  const e = INSTANCE_KEYS.find((k) => k.key === key);
  if (!e) throw new Error(`setup: ${key} is not in the settings schema`);
  return e.label;
};

/** Where the sign-up switch lives afterwards. setupValidate.test.ts holds these words to the Admin
 *  Panel's own layout (adminLayout.ts KEY_GROUPS), so a move there fails a test here. */
export const SIGNUP_SWITCH = { place: "Admin Panel → Site → Community server", label: keyLabel("matrix.registration") } as const;

/** A "who can join" answer, or null when it is not one. */
export function joinChoice(v: unknown): JoinChoice | null {
  return v === "open" || v === "closed" ? v : null;
}

/** The Community step's POST: the federation switch and the answer to "who can join?" — both needed. */
export function validateCommunityStep(body: Record<string, unknown>):
  { ok: true; federation: boolean; registration: JoinChoice } | { ok: false; error: string } {
  if (typeof body.federation !== "boolean") return { ok: false, error: "federation: on or off" };
  const registration = joinChoice(body.registration);
  if (!registration) return { ok: false, error: "who can join: choose open sign-up or closed" };
  return { ok: true, federation: body.federation, registration };
}

/** What the stored switch means, in words for the Finish page. Unset is closed — as the host renders it. */
export function joinWords(stored: unknown): { state: JoinChoice; words: string } {
  return joinChoice(stored) === "open"
    ? { state: "open", words: "Open sign-up: anyone can make an account on this site and join the community." }
    : { state: "closed", words: "Closed: nobody can make a new account on this site on their own — an admin makes them." };
}

// ── Finish: phone alerts (optional) ──────────────────────────────────────────────────────────
// The operator's push alerts go to two ntfy topics (stream-api notify.js): an urgent one and a quiet
// one. notify.js sends nothing unless BOTH are set — one alone would silently misroute a tier — so the
// page takes both or neither. Each topic's address is the secret (anyone who knows it can read it):
// never shown back; a blank field keeps what is saved.

const ALERT_KEYS = { wake: "ntfy.wakeUrl", quiet: "ntfy.quietUrl" } as const;
type AlertKey = (typeof ALERT_KEYS)[keyof typeof ALERT_KEYS];
const ALERTS_PLACE = "Admin Panel → Site → Health";

function topicUrl(v: string): boolean {
  if (v.length > 300 || /\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && u.pathname.replace(/\/+$/, "").length > 1;
  } catch { return false; }
}

/** The Finish page's alert topics. `saved`: whether each is already set. → the keys to write (none
 *  when both are blank: alerts are optional). */
export function validateAlertTopics(input: unknown, saved: { wake: boolean; quiet: boolean }):
  { ok: true; write: Partial<Record<AlertKey, string>> } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, write: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "alerts: the two topic addresses expected" };
  const o = input as Record<string, unknown>;
  const write: Partial<Record<AlertKey, string>> = {};
  const set = { ...saved };
  for (const tier of ["wake", "quiet"] as const) {
    const v = o[tier];
    if (v === undefined) continue;
    if (typeof v !== "string") return { ok: false, error: "alerts: text expected" };
    const s = v.trim();
    if (!s) continue; // blank keeps what is saved
    if (!topicUrl(s)) return { ok: false, error: `${tier === "wake" ? "Urgent" : "Quiet"} alerts: a topic's full address, like https://ntfy.sh/a-long-private-name` };
    write[ALERT_KEYS[tier]] = s;
    set[tier] = true;
  }
  if (set.wake !== set.quiet) return { ok: false, error: "alerts: give both topics, urgent and quiet, or neither — one alone sends nothing" };
  if (write[ALERT_KEYS.wake] !== undefined && write[ALERT_KEYS.wake] === write[ALERT_KEYS.quiet]) {
    return { ok: false, error: "alerts: the urgent and the quiet topic must differ, so muting the quiet one never mutes the urgent one" };
  }
  return { ok: true, write };
}

/** Whether each alert topic is set, from stream-api's own status of the keys it reads (its /config
 *  `self`: a secret that resolves shows `…abcd` or "(set)", an unset one null). The topics are
 *  stream-api's alone, so web's own settings layer never holds them. Null: stream-api did not say. */
export function alertsSet(self: Record<string, { display: unknown }> | null | undefined): { wake: boolean; quiet: boolean } | null {
  if (!self) return null;
  const has = (k: AlertKey) => self[k]?.display !== null && self[k]?.display !== undefined;
  return { wake: has(ALERT_KEYS.wake), quiet: has(ALERT_KEYS.quiet) };
}

/** The Finish page's line about alerts. */
export function alertWords(saved: { wake: boolean; quiet: boolean } | null): string {
  if (!saved) return `Whether phone alerts are set up could not be checked just now (${ALERTS_PLACE} shows it).`;
  return saved.wake && saved.quiet
    ? "Phone alerts are on: urgent problems go to the urgent topic, the rest to the quiet one."
    : `No phone alerts are set up — that is fine. Important problems always show in the Admin Panel (Doctor); alerts pushed to your phone are optional, and can be added any time in ${ALERTS_PLACE}.`;
}
