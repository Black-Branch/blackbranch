"use client";

// Instance keys as cards of rows: where each
// service gets a key, and — for credentials — set / not set, `…abcd`, last tested, a Test button
// and a write-only input. Which keys sit in which card is adminLayout.ts.
//
// A plain setting's editor starts from its current value (a choice on it, a text box filled with
// it, a list as its items with add and remove), so a save changes what was meant and nothing else.
// A credential never comes back: its input stays empty and is cleared the moment it is saved.
// Every route behind this checks is_admin itself — this component being admin-only is not the
// guard.

import { useEffect, useRef, useState } from "react";
import { postJson } from "@/app/lib/http";
import { Toggle } from "@/app/components/SettingsControls";
import type { InstanceView } from "@/app/lib/instanceAdminView";
import { card, h2, btn, input, chip, ago, Fold } from "./parts";
import {
  splitHint, pendingRestarts, desiredSwitch, currentList, listAdd, listRemove, draftOf, hostApplyState, MANAGED_ELSEWHERE,
} from "./keyRowText";
import { serviceName, type KeyGroup } from "./adminLayout";
import { keyInstalled } from "@/app/lib/plugins/installed";

type KeyView = InstanceView["keys"][number];
type Render = InstanceView["render"];

function shown(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "(empty list)";
  return String(v);
}

const SOURCE_WORD: Record<string, string> = {
  env: "set on the server", database: "saved here", default: "default", unset: "not set",
};

/** When a restart-applied setting takes effect in each service that reads it: the website reads
 *  its settings as it goes, the two services take theirs when they start, and the host re-renders
 *  the homeserver for the settings it applies. */
const APPLIES: Record<string, string> = {
  web: "at once (the next page load)",
  "stream-api": "at its next restart",
  "stream-ingest": "at its next restart",
};
const HOST_APPLIES = "when the server re-renders the homeserver's config (asked for on every save)";

/** When one service takes a restart setting. A module (config/modules.mjs) is on where the service
 *  that runs it runs it: the website shows such a module from that service's report, so for the
 *  website it follows that service's restart; only a switch the website alone reads applies at once. */
function appliesIn(k: KeyView, pkg: string): string {
  if (pkg === "web" && k.key.startsWith("modules.")) {
    const runner = k.packages.find((p) => p.package !== "web");
    if (runner) return `when the ${serviceName(runner.package)} restarts — it shows the module from that service's report`;
  }
  return APPLIES[pkg] ?? "at its next restart";
}

/** Whether a row's value is empty everywhere it is read. */
function emptyEverywhere(k: KeyView): boolean {
  return k.packages.every((p) => p.display === null || p.display === undefined || p.display === "" || (Array.isArray(p.display) && p.display.length === 0));
}

/** A host-applied setting after a save: applying until the host's render answers, then its result.
 *  While applying it asks for the view again every few seconds, for at most two minutes. */
function HostApplyLine({ k, render, onChanged }: { k: KeyView; render: Render; onChanged: () => void }) {
  const st = hostApplyState(k, render);
  const reload = useRef(onChanged);
  useEffect(() => { reload.current = onChanged; }, [onChanged]);
  useEffect(() => {
    if (st.state !== "applying") return;
    let n = 0;
    const t = setInterval(() => { n += 1; if (n > 40) clearInterval(t); else reload.current(); }, 3_000);
    return () => clearInterval(t);
  }, [st.state]);
  if (st.state === "none") return null;
  if (st.state === "applying") return <p role="status" className="mt-1 text-xs text-amber-300" data-host-apply="applying">Applying… the server is re-rendering the homeserver&apos;s config.</p>;
  if (st.state === "failed") return <p className="mt-1 text-xs text-red-300 break-words" data-host-apply="failed">The server could not apply it: {st.message || "no reason given"}</p>;
  return <p className="mt-1 text-xs text-secondary" data-host-apply="applied">Applied by the server {ago(st.at)}.</p>;
}

function KeyRow({ k, onChanged, note, bundle, render }: {
  k: KeyView; onChanged: () => void; note: (m: string) => void; bundle: boolean; render: Render;
}) {
  // A plain setting starts from its value; a credential and a list's "add" box start empty.
  const [draft, setDraft] = useState(() => (k.secret || k.kind === "list" ? "" : draftOf(k)));
  const [busy, setBusy] = useState(false);
  // A setting the host applies, on a homeserver the bundle does not run: nothing here reaches it.
  const managedOutside = k.hostApplied && !bundle;
  const editable = k.tier !== "install" && !managedOutside;
  const envOver = k.packages.filter((p) => p.envOverrides).map((p) => serviceName(p.package));
  const list = k.kind === "list" ? currentList(k) : [];
  const start = k.secret || k.kind === "list" ? "" : draftOf(k);

  // A switch (bool kind) saves the moment it is flipped — the one-control standard's Toggle, not
  // a text box asking for "true". Its state is what the service that ACTS on it resolves: the
  // website where it reads the switch, else the first service that does (a module switch is the
  // chat service's). A switch no service reads would have no state to show.
  const switchView = k.packages.find((p) => p.package === "web") ?? k.packages[0];
  // The saved state: a service reports a restart-applied switch as what it
  // RUNS, so its report alone would show the old state right after a flip.
  const switchOn = k.kind === "bool" ? desiredSwitch(k) : switchView?.display === true;

  async function put(value: unknown, done: string): Promise<boolean> {
    setBusy(true);
    try {
      const res = await postJson(`/api/admin/instance/${encodeURIComponent(k.key)}`, { value }, "PUT");
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) { note(`${k.label}: ${done}`); onChanged(); return true; }
      note(`${k.label}: ${j.error ?? "not saved"}`);
    } catch { note(`${k.label}: not saved (network)`); }
    finally { setBusy(false); }
    return false;
  }
  const flip = () => void put(!switchOn, `${!switchOn ? "on" : "off"}.`);

  async function save() {
    const raw = draft.trim();
    if (!raw) return;
    // A list saves the WHOLE list — the items already there plus what was typed.
    if (k.kind === "list") { if (await put(listAdd(list, raw), "added.")) setDraft(""); return; }
    if (raw === start) return;
    if (await put(raw, "saved.") && k.secret) setDraft("");
  }
  const remove = (item: string) => void put(listRemove(list, item), `${item} removed.`);
  async function clear() {
    setBusy(true);
    try {
      const res = await postJson(`/api/admin/instance/${encodeURIComponent(k.key)}`, undefined, "DELETE");
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      note(res.ok ? `${k.label}: saved value removed.` : `${k.label}: ${j.error ?? "not removed"}`);
      if (res.ok) onChanged();
    } catch { note(`${k.label}: not removed (network)`); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true);
    try {
      const res = await postJson(`/api/admin/instance/${encodeURIComponent(k.key)}/test`);
      const j = (await res.json().catch(() => ({}))) as { results?: { package: string; ok: boolean; detail: string }[]; error?: string };
      if (res.ok && j.results) note(`${k.label}: ${j.results.map((r) => `${serviceName(r.package)} ${r.ok ? "✓" : "✗"} ${r.detail}`).join(" · ")}`);
      else note(`${k.label}: ${j.error ?? "test failed"}`);
      onChanged();
    } catch { note(`${k.label}: test failed (network)`); }
    finally { setBusy(false); }
  }

  const { hint, rest } = splitHint(k.description);
  const webView = k.packages.find((p) => p.package === "web") ?? k.packages[0];
  // A service still running the old value of this setting (the card's banner says which).
  const pendingHere = pendingRestarts([k]).length > 0;
  const changed = k.secret || k.kind === "list" ? !!draft.trim() : !!draft.trim() && draft.trim() !== start;

  return (
    <li className="border-t border-edge pt-3 first:border-t-0 first:pt-0" data-key={k.key}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-body">{k.label}</span>
        {/* A switch sits right beside what it switches. */}
        {editable && k.kind === "bool" && (
          <>
            <Toggle on={switchOn} onToggle={flip} disabled={busy || !switchView?.known} label={k.label} />
            <span className="text-xs text-secondary">{switchOn ? "On" : "Off"}</span>
            {k.stored && <button type="button" className={btn} disabled={busy} onClick={clear}>Clear saved</button>}
          </>
        )}
        {managedOutside && (
          <span className="min-w-0 text-xs text-secondary" data-managed-outside>
            <span aria-hidden="true">🔒 </span>Managed outside Black Branch
          </span>
        )}
        {k.tier === "install" && (
          <span className="min-w-0 text-xs text-secondary break-all">
            <span aria-hidden="true">🔒 </span>{emptyEverywhere(k) ? "not set" : shown(webView?.display)}
          </span>
        )}
      </div>
      {hint && <p className="mt-0.5 text-xs text-secondary">{hint}</p>}
      {managedOutside && (
        <p className="mt-0.5 text-xs text-muted">
          This install&apos;s homeserver is not run by the bundle, so this switch would change nothing. {MANAGED_ELSEWHERE[k.key] ?? "Change it in the homeserver's own config."}
        </p>
      )}

      {editable && k.kind === "list" && (
        <ul className="mt-2 flex flex-wrap items-center gap-1.5" aria-label={`${k.label} now`}>
          {list.length === 0 && <li className="text-xs text-muted">None yet.</li>}
          {list.map((item) => (
            <li key={item} className={`${chip} min-w-0 max-w-full text-body`}>
              <span className="min-w-0 font-mono break-all">{item}</span>
              <button type="button" className="text-muted hover:text-body disabled:opacity-40" disabled={busy} onClick={() => remove(item)} aria-label={`Remove ${item}`}>×</button>
            </li>
          ))}
        </ul>
      )}

      {editable && k.kind !== "bool" && (
        // A form (not a div) so Enter saves, and password managers see a real form — but it
        // never posts natively: onSubmit always prevents it and goes through save().
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(ev) => { ev.preventDefault(); void save(); }}>
          {k.kind === "enum" ? (
            <select className={input} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`${k.label}`}>
              {start === "" && <option value="">not set — choose…</option>}
              {(k.values ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          ) : (
            <input
              className={input}
              type={k.secret ? "password" : "text"}
              inputMode={k.kind === "number" ? "decimal" : undefined}
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={k.secret ? (k.stored ? `saved ${shown(k.stored.display)}, type to replace` : "paste to save") : (k.kind === "list" ? "add one (or several, comma-separated)" : k.kind === "number" ? `a number${k.defaultValue !== null && k.defaultValue !== undefined ? ` (default ${String(k.defaultValue)})` : ""}` : "not set")}
              aria-label={k.kind === "list" ? `Add to ${k.label}` : k.secret ? `New value for ${k.label}` : k.label}
            />
          )}
          <button type="submit" className={btn} disabled={busy || !changed}>{k.kind === "list" ? "Add" : "Save"}</button>
          {k.stored && <button type="button" className={btn} disabled={busy} onClick={clear}>Clear saved</button>}
          {k.testable && <button type="button" className={btn} disabled={busy} onClick={test}>Test</button>}
        </form>
      )}

      {/* Warnings stay outside the fold: each one means something needs doing. */}
      {editable && k.hostApplied && <HostApplyLine k={k} render={render} onChanged={onChanged} />}
      {k.disagree && !pendingHere && !k.hostApplied && <p className="mt-1 text-xs text-amber-300">The services do not hold the same value.</p>}
      {k.stored?.error && <p className="mt-1 text-xs text-red-300">The saved value cannot be read: {k.stored.error}</p>}
      {editable && envOver.length > 0 && (
        <p className="mt-1 text-xs text-amber-300">Set on the server for the {envOver.join(" and ")} — a saved value takes effect there only once that server setting is removed.</p>
      )}
      {pendingHere && (
        <p className="mt-1 text-xs text-amber-300">Waiting for a restart — see the note at the top of this card.</p>
      )}

      {/* Everything else is behind Details, closed by default. */}
      <Fold id={k.key}>
        {rest && <p className="text-xs text-secondary">{rest}</p>}
        <p className="text-2xs text-muted"><span className="font-mono break-all">{k.key}</span></p>
        {/* A setting a service takes when it starts: when it takes effect in each one that reads it. */}
        {k.reload === "restart" && k.tier !== "install" && !managedOutside && (
          <ul className="space-y-0.5 text-xs text-secondary" aria-label="When it applies">
            {k.packages.map((p) => {
              const stale = pendingRestarts([{ ...k, packages: [p] }]).length > 0;
              return (
                <li key={p.package} className="flex flex-wrap items-center gap-x-2">
                  <span><span className="inline-block text-body first-letter:uppercase">{serviceName(p.package)}:</span> {k.hostApplied ? HOST_APPLIES : appliesIn(k, p.package)}</span>
                  {stale && <span className="text-amber-300">{k.kind === "bool" ? `still ${p.display === true ? "on" : "off"}` : "still on the old value"} — waiting for a restart</span>}
                </li>
              );
            })}
          </ul>
        )}
        <ul className="flex flex-wrap gap-1.5" aria-label="Where each service gets it">
          {k.packages.map((p) => (
            <li key={p.package} className={`${chip} min-w-0 max-w-full flex-wrap ${p.error ? "text-red-300" : p.source === "unset" ? "text-muted" : "text-secondary"}`}>
              <span className="font-medium text-body">{serviceName(p.package)}</span>
              {!p.known ? "not reporting" : (
                <>
                  <span>{SOURCE_WORD[p.source ?? ""] ?? p.source}{p.envName && p.source === "env" ? ` (${p.envName})` : ""}</span>
                  {p.display !== null && <span className="min-w-0 font-mono text-body-dim break-all">{shown(p.display)}</span>}
                  {p.error && <span>· {p.error}</span>}
                </>
              )}
            </li>
          ))}
        </ul>
        {/* A credential with no Test says nothing here, rather than "no test available" on every row. */}
        {k.secret && (k.testable || k.tests.length > 0) && (
          <p className="text-xs text-muted">
            Last tested:{" "}
            {k.tests.length === 0 ? "never"
              : k.tests.map((t) => (
                <span key={t.package} className={`mr-2 ${t.ok ? "text-emerald-400" : "text-red-300"}`}>
                  {serviceName(t.package)} {t.ok ? "✓" : "✗"} {t.detail} ({ago(t.testedAt)})
                </span>
              ))}
          </p>
        )}
        {k.tier === "install" && (
          // An install key: by design not editable here.
          <div className="space-y-0.5 text-xs text-muted" data-install-row>
            {k.packages.some((p) => p.package === "web") ? (
              <p>🔒 Set in the website&apos;s environment, so it can&apos;t be changed here. To change it: set <span className="font-mono">{k.envNames[0]}</span> there (on a bundled install: <span className="font-mono">blackbranch set {k.envNames[0]} …</span>, for the display values), then restart the website.</p>
            ) : (
              // A server-only install key (an address a credential is sent to): never edited here.
              <p>🔒 Set on the server only, so it can&apos;t be changed here. To change it: set <span className="font-mono">{k.envNames[0]}</span> in the {k.packages.map((p) => serviceName(p.package)).join(" and ")}&apos;s environment, then restart it.</p>
            )}
            {emptyEverywhere(k) && <p>Not set on this install — the part that uses it stays off or uses its default.</p>}
          </div>
        )}
        {k.stored && (
          <p className="text-2xs text-muted">Saved {ago(k.stored.updatedAt)} by <span className="font-mono">{k.stored.updatedBy}</span></p>
        )}
      </Fold>
    </li>
  );
}

function PendingRestart({ pending, canRestart, note }: { pending: ReturnType<typeof pendingRestarts>; canRestart: boolean; note: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function restart(service: string) {
    setBusy(true);
    try {
      const res = await postJson("/api/admin/restart", { service });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      note(res.ok ? `Asked the server to restart the ${serviceName(service)}. The settings apply once it is back.` : `Restart: ${j.error ?? "not asked"}`);
    } catch { note("Restart: not asked (network)"); }
    finally { setBusy(false); }
  }
  return (
    <div role="status" className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 space-y-1.5" data-pending-restart>
      <p className="font-medium">Pending restart — saved settings are not in effect everywhere yet.</p>
      {pending.map((p) => (
        <div key={p.service} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span><span className="first-letter:uppercase inline-block">{serviceName(p.service)}</span> still runs the old value of {p.labels.join(", ")}.</span>
          {canRestart
            ? <button type="button" className={btn} disabled={busy} onClick={() => void restart(p.service)}>Restart the {serviceName(p.service)}</button>
            : <span className="text-amber-200/80">Restart it on the server: <span className="font-mono">blackbranch restart {p.service}</span> on a bundle install, else restart its service.</span>}
        </div>
      ))}
    </div>
  );
}

/** A row's identity: a saved change remounts it, so its editor starts from the new value. */
const rowKey = (k: KeyView) => `${k.key}:${k.stored?.updatedAt ?? ""}:${JSON.stringify(k.packages.map((p) => p.display))}`;

/** The given groups of keys, one card each, from an already-loaded view. */
export default function KeyCards({ view, groups, onChanged, note, placeLabel }: {
  view: InstanceView; groups: readonly KeyGroup[]; onChanged: () => void; note: (m: string) => void;
  /** The open place's name: a card titled the same hides its title where the picker heads the place. */
  placeLabel?: string;
}) {
  // An older server that does not say: treat it as a bundle, the way it behaved before.
  const bundle = view.bundle !== false;
  return (
    <>
      {groups.map((g) => {
        // A key of an owner-only module this install does not have is not shown.
        const keys = g.keys.filter(keyInstalled).map((key) => view.keys.find((k) => k.key === key)).filter((k): k is KeyView => !!k);
        if (!keys.length) return null;
        return (
          <section key={g.title} className={card} aria-label={g.title}>
            <h2 className={h2} data-repeats-place={g.title === placeLabel ? "" : undefined}>{g.title}</h2>
            {g.blurb && <p className="mt-0.5 text-xs text-muted">{g.blurb}</p>}
            {(() => { const pend = pendingRestarts(keys); return pend.length ? <PendingRestart pending={pend} canRestart={view.canRestart === true} note={note} /> : null; })()}
            <ul className="mt-3 space-y-3">
              {keys.map((k) => <KeyRow key={rowKey(k)} k={k} onChanged={onChanged} note={note} bundle={bundle} render={view.render ?? null} />)}
            </ul>
          </section>
        );
      })}
    </>
  );
}
