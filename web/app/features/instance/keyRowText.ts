// What a settings row says and holds: the one-line hint, the value it starts from, a list's
// add/remove, which services still run an old value, and how far a host-applied setting has got.
// Pure.

/** The first sentence (the hint) and everything after it. A description with one sentence has no rest. */
export function splitHint(description: string | null | undefined): { hint: string; rest: string } {
  const text = (description ?? "").trim();
  // A sentence ends at . ! or ? followed by a space and a capital, a digit or a quote — so "e.g. x"
  // and "1.5 s" do not cut it short.
  const m = /^([\s\S]*?[.!?])\s+(?=[A-Z0-9"“(⚠])/.exec(text);
  if (!m) return { hint: text, rest: "" };
  return { hint: m[1]!, rest: text.slice(m[0].length).trim() };
}

type Row = {
  key: string; label: string; kind: string; tier: string; defaultValue?: unknown;
  secret?: boolean;
  /** The schema's reload: 'restart' = a service takes the value when it starts. */
  reload?: string;
  /** The host applies it by re-rendering the homeserver's config (hostRequests.ts). */
  hostApplied?: boolean;
  stored?: { display: unknown; updatedAt?: string } | null;
  packages: readonly { package: string; known: boolean; display: unknown; source?: string | null }[];
};

/** A switch's wanted state: the saved value; with none saved, what the website reads (it applies
 *  at once), else the default. A service's own report of a restart-applied switch is what it RUNS,
 *  so it is never the answer here. */
export function desiredSwitch(k: Row): boolean {
  if (k.stored) return k.stored.display === true;
  const web = k.packages.find((p) => p.package === "web");
  if (web) return web.display === true;
  if (k.defaultValue !== undefined && k.defaultValue !== null) return k.defaultValue === true;
  return k.packages[0]?.display === true;
}

/** The value a restart brings a service to, as the page shows it (`…abcd` for a credential). */
function desiredDisplay(k: Row): unknown {
  if (k.kind === "bool") return desiredSwitch(k);
  if (k.stored) return k.stored.display;
  const web = k.packages.find((p) => p.package === "web");
  if (web) return web.display;
  return k.defaultValue ?? null;
}

/** The services still running an old value, and of which settings: every `reload: 'restart'`
 *  setting (the schema says which), compared with what each service reports it runs. The website
 *  reads its settings as it goes, so it is never waiting; a host-applied setting waits for the
 *  host, not a restart; a service whose own environment sets the value would not change on one. */
export function pendingRestarts(keys: readonly Row[]): { service: string; labels: string[] }[] {
  const by = new Map<string, string[]>();
  for (const k of keys) {
    if (k.reload !== "restart" || k.tier === "install" || k.hostApplied) continue;
    const want = JSON.stringify(desiredDisplay(k) ?? null);
    for (const p of k.packages) {
      if (p.package === "web" || !p.known || p.source === "env") continue;
      if (JSON.stringify(p.display ?? null) === want) continue;
      by.set(p.package, [...(by.get(p.package) ?? []), k.label]);
    }
  }
  return [...by].map(([service, labels]) => ({ service, labels }));
}

/** What a row holds now, as a non-secret editor shows it: the saved value; with none saved, what
 *  the website reads (else the first service that reads it), else the default. Never a secret's.
 *  The rows read it through currentList and draftOf; the help desk's picture card reads the bot
 *  account through it. */
export function currentValue(k: Row): unknown {
  if (k.secret) return null;
  if (k.stored) return k.stored.display;
  const view = k.packages.find((p) => p.package === "web") ?? k.packages[0];
  const v = view?.known ? view.display : null;
  return v ?? k.defaultValue ?? null;
}

/** A list row's items now (strings only). */
export function currentList(k: Row): string[] {
  const v = currentValue(k);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The list after adding what was typed: comma- or space-separated, trimmed, no duplicates. The
 *  whole list is what is saved — a save replaces the stored list, so the items already there ride
 *  along. */
export function listAdd(current: readonly string[], typed: string): string[] {
  const out = [...current];
  for (const item of typed.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) if (!out.includes(item)) out.push(item);
  return out;
}

/** The list without one item. */
export function listRemove(current: readonly string[], item: string): string[] {
  return current.filter((x) => x !== item);
}

/** A text or number row's editor starts from its current value; a choice starts on it too. */
export function draftOf(k: Row): string {
  const v = currentValue(k);
  return v === null || v === undefined || typeof v === "object" ? "" : String(v);
}

/** Where to change a host-applied setting on a homeserver the bundle does not run. */
export const MANAGED_ELSEWHERE: Record<string, string> = {
  "matrix.federation": "Federation is set in the homeserver's own config (its federation listener, and which servers it federates with).",
  "matrix.registration": "Sign-up is set in the homeserver's sign-in service (with MAS: password registration in its config).",
};

/** A host-applied setting's progress after a save: the host's last render answers the save once it
 *  is no older than it. */
export function hostApplyState(k: Row, render: { ok: boolean; at: string; message: string } | null | undefined):
  { state: "none" } | { state: "applying" } | { state: "applied"; at: string } | { state: "failed"; message: string } {
  const saved = k.stored?.updatedAt ? Date.parse(k.stored.updatedAt) : NaN;
  if (Number.isNaN(saved)) return { state: "none" };
  const done = render ? Date.parse(render.at) : NaN;
  // The host's answer carries whole seconds: allow the one it rounds away.
  if (!render || Number.isNaN(done) || done < saved - 1_000) return { state: "applying" };
  return render.ok ? { state: "applied", at: render.at } : { state: "failed", message: render.message };
}
