"use client";

// The setup pages: first admin → recovery sheet → your site → points → modules → each module's own
// page → community → finish. The server decides which page this browser is on (setupView) and
// checks every value again; this file only draws the page and posts it. Controls follow
// docs/DESIGN-STANDARD.md (24px, FIELD, Toggle).

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FIELD, Toggle } from "@/app/components/SettingsControls";
import { deviceIdForSignIn } from "@/app/lib/deviceId";
import type { SetupView } from "@/app/lib/setup/setupServer";
import type { FormField } from "@/app/lib/setup/setupValidate";
import type { SetupPage } from "@/app/lib/setup/setupPages";
import { previousStep } from "@/app/lib/setup/setupFlow";
import SetupStepGuide from "@/app/components/SetupStepGuide";
import { PRODUCT_MARK } from "@/app/lib/siteIcons";

const card = "rounded-xl border border-edge bg-surface-1 p-4 space-y-3";
const btn = "h-6 shrink-0 px-2.5 rounded-md border border-edge bg-surface-2 hover:bg-surface-3 text-xs font-medium text-body transition-colors outline-none focus-visible:ring-1 focus-visible:ring-edge-bright disabled:opacity-40";
const primary = "h-6 shrink-0 px-3 rounded-md bg-strong text-on-accent text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-edge-bright disabled:opacity-40";
const input = `${FIELD} w-full min-w-0 px-2 text-xs placeholder:text-muted disabled:opacity-60`;
const label = "block text-xs font-medium text-body";
const hint = "text-2xs text-muted";

const TITLES: Record<string, string> = {
  admin: "Your account", recovery: "Recovery sheet", site: "Your site", points: "Points",
  modules: "Modules", community: "Community", finish: "Finish",
};
const titleOf = (step: string) => TITLES[step] ?? (step.startsWith("core:") ? "Platform setup" : "Module setup");

type Json = Record<string, unknown>;

/** fetch + JSON, with the server's error words on a refusal (a 4xx is a failure here). */
async function call(path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Json }> {
  try {
    const res = await fetch(path, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const json = ((await res.json().catch(() => ({}))) ?? {}) as Json;
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: { error: "the site did not answer — try again in a moment" } };
  }
}
const errorOf = (j: Json, fallback = "that did not work") => (typeof j.error === "string" ? j.error : fallback);

async function startSignIn(loginHint: string | null): Promise<string | null> {
  const deviceId = await deviceIdForSignIn();
  const r = await call("/api/auth/mas-initiate", { deviceId, ...(loginHint ? { loginHint } : {}) });
  if (r.ok && typeof r.json.authorizationUrl === "string") { window.location.href = r.json.authorizationUrl; return null; }
  return r.status === 503 ? "sign-in is not available right now: the site cannot reach its homeserver" : errorOf(r.json, "sign-in did not start");
}

function Shell({ siteName, children, step }: { siteName: string; children: React.ReactNode; step?: { n: number; of: number; title: string } }) {
  return (
    // html/body never scroll (layout.tsx): the page is its own scroll box, as /about is.
    <div className="h-dvh overflow-y-auto bg-canvas px-4 py-8">
      <div className="mx-auto w-full max-w-xl space-y-4">
        <header className="space-y-3">
          <div className="flex items-center gap-3">
            <img src={PRODUCT_MARK} alt="Black Branch" width={32} height={32} className="size-8 shrink-0" />
            <div className="min-w-0">
              <p className={hint}>Setting up</p>
              <h1 className="text-lg font-semibold text-heading break-words">{siteName}</h1>
            </div>
          </div>
          {step && (
            <div className="space-y-1.5">
              <p className="text-xs text-secondary">Step {step.n} of {step.of} · <span className="text-body font-medium">{step.title}</span></p>
              <div className="h-1 rounded-full bg-surface-2" aria-hidden>
                <div className="h-1 rounded-full bg-strong" style={{ width: `${Math.round((step.n / step.of) * 100)}%` }} />
              </div>
            </div>
          )}
        </header>
        {children}
      </div>
    </div>
  );
}

function Problem({ text }: { text: string | null }) {
  return text ? <p role="alert" className="text-xs text-red-400">{text}</p> : null;
}

// ── before the wizard ───────────────────────────────────────────────────────────────────────

function NotYou({ adminExists }: { adminExists: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className={card}>
      <h2 className="text-sm font-semibold text-body">This site is being set up</h2>
      <p className="text-sm text-secondary">Come back soon — it opens once its owner has finished setting it up.</p>
      {adminExists ? (
        <div className="space-y-2 border-t border-edge pt-3">
          <p className={hint}>Are you the owner? Sign in to carry on where you left off.</p>
          <button className={btn} disabled={busy} onClick={async () => { setBusy(true); setErr(await startSignIn(null)); setBusy(false); }}>Sign in</button>
          <Problem text={err} />
        </div>
      ) : (
        <p className={`${hint} border-t border-edge pt-3`}>Owner: open the setup link the installer printed. On the server, <code className="text-body">blackbranch setup-link</code> prints it again.</p>
      )}
    </section>
  );
}

function FirstAdmin({ token, serverName, domain }: { token: string; serverName: string; domain: string }) {
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) { setErr("the two passwords differ"); return; }
    setBusy(true); setErr(null);
    const r = await call("/api/setup/admin", { token, username: name, password: pw });
    if (!r.ok) { setErr(errorOf(r.json)); setBusy(false); return; }
    const id = String(r.json.matrixId);
    setMade(id);
    setErr(await startSignIn(id));
    setBusy(false);
  };
  if (made) {
    return (
      <section className={card}>
        <h2 className="text-sm font-semibold text-body">Account made: {made}</h2>
        <p className="text-sm text-secondary">Taking you to sign in with it — the setup carries on right after.</p>
        <Problem text={err} />
        {err && <button className={btn} onClick={async () => setErr(await startSignIn(made))}>Sign in</button>}
      </section>
    );
  }
  return (
    <form className={card} onSubmit={submit}>
      <h2 className="text-sm font-semibold text-body">Make your admin account</h2>
      <p className="text-sm text-secondary">This is the account you run the site with: it owns the community and opens the Admin Panel.</p>
      <div className="space-y-1">
        <label className={label} htmlFor="bb-user">User name</label>
        <input id="bb-user" className={input} autoComplete="username" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} required maxLength={64} />
        <p className={hint}>Your account will be <span className="text-body">@{name || "name"}:{serverName}</span>.</p>
      </div>
      <div className="space-y-1">
        <label className={label} htmlFor="bb-pw">Password</label>
        <input id="bb-pw" className={input} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={8} />
        <label className={label} htmlFor="bb-pw2">Password again</label>
        <input id="bb-pw2" className={input} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required minLength={8} />
        <p className={hint}>A long one: the account server refuses passwords that are easy to guess.</p>
      </div>
      <p className={`${hint} border-t border-edge pt-3`}>
        Good to know: the site&apos;s address (<span className="text-body">{domain}</span>) and the community&apos;s server name (<span className="text-body">{serverName}</span>) are permanent — they can never be changed.
      </p>
      <Problem text={err} />
      <button className={primary} disabled={busy || !name || !pw}>{busy ? "Making the account…" : "Make the account"}</button>
    </form>
  );
}

// ── the wizard's pages ──────────────────────────────────────────────────────────────────────

function Nav({ back, onBack, busy, next = "Continue", disabled }: { back: boolean; onBack: () => void; busy: boolean; next?: string; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      {back ? <button type="button" className={btn} onClick={onBack} disabled={busy}>Back</button> : <span />}
      <button className={primary} disabled={busy || disabled}>{busy ? "Saving…" : next}</button>
    </div>
  );
}

function Recovery({ save }: { save: (data: Json) => Promise<void> }) {
  const [sheet, setSheet] = useState<{ passphrase: string | null; envFile: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call("/api/setup/recovery").then((r) => {
      if (r.ok) setSheet({ passphrase: (r.json.passphrase as string | null) ?? null, envFile: (r.json.envFile as string | null) ?? null });
      else setErr(errorOf(r.json));
    });
  }, []);
  return (
    <form className={card} onSubmit={async (e) => { e.preventDefault(); setBusy(true); await save({ saved }); setBusy(false); }}>
      <h2 className="text-sm font-semibold text-body">Save your recovery sheet</h2>
      <p className="text-sm text-secondary">
        Your backups are locked with this passphrase. Without it a backup cannot be opened — nobody can recover it for you. It is shown here once.
      </p>
      {sheet ? (
        <dl className="space-y-2">
          <div>
            <dt className={hint}>Backup passphrase</dt>
            <dd className="mt-0.5 rounded-md border border-edge bg-surface-2 px-2 py-1.5 font-mono text-xs text-strong break-all select-all">{sheet.passphrase ?? "— not on this install —"}</dd>
          </div>
          <div>
            <dt className={hint}>Every key and password of this install lives on the server in</dt>
            <dd className="mt-0.5 font-mono text-xs text-body break-all">{sheet.envFile ?? ".env, beside the install"}</dd>
          </div>
        </dl>
      ) : !err && <p className={hint}>Loading…</p>}
      <p className={hint}>Write it down or keep it in a password manager, and keep a copy of that file somewhere other than the server.</p>
      <label className="flex items-center gap-2 text-xs text-body">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I have saved this
      </label>
      <Problem text={err} />
      <Nav back={false} onBack={() => {}} busy={busy} disabled={!saved} />
    </form>
  );
}

function FieldsForm({ title, intro, fields, values, back, onBack, save, footer }: {
  title: string; intro: React.ReactNode; fields: FormField[]; values: Record<string, string>;
  back: boolean; onBack: () => void; save: (data: Json) => Promise<void>; footer?: React.ReactNode;
}) {
  const [v, setV] = useState<Record<string, string>>(values);
  const [busy, setBusy] = useState(false);
  return (
    <form className={card} onSubmit={async (e) => { e.preventDefault(); setBusy(true); await save(v); setBusy(false); }}>
      <h2 className="text-sm font-semibold text-body">{title}</h2>
      <div className="text-sm text-secondary">{intro}</div>
      {fields.map((f) => (
        <div key={f.name} className="space-y-1">
          <label className={label} htmlFor={`bb-${f.name}`}>{f.label}{f.required ? "" : <span className="text-muted font-normal"> · optional</span>}</label>
          <input id={`bb-${f.name}`} className={input} value={v[f.name] ?? ""} maxLength={f.max} placeholder={f.placeholder}
            required={f.required} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
          <p className={hint}>{f.description}</p>
        </div>
      ))}
      {footer}
      <Nav back={back} onBack={onBack} busy={busy} />
    </form>
  );
}

function Modules({ data, back, onBack, save }: { data: Json; back: boolean; onBack: () => void; save: (d: Json) => Promise<void> }) {
  const mods = (data.modules as { id: string; label: string; description: string; on: boolean; hasSetup: boolean }[]) ?? [];
  const later = (data.later as { id: string; label: string; description: string }[]) ?? [];
  const core = (data.core as { id: string; label: string; description: string; chosen: boolean }[]) ?? [];
  const [on, setOn] = useState<Record<string, boolean>>(Object.fromEntries(mods.map((m) => [m.id, m.on])));
  const [chosen, setChosen] = useState<Record<string, boolean>>(Object.fromEntries(core.map((c) => [c.id, c.chosen])));
  const [busy, setBusy] = useState(false);
  return (
    <form className={card} onSubmit={async (e) => {
      e.preventDefault(); setBusy(true);
      await save({ modules: on, core: core.filter((c) => chosen[c.id]).map((c) => c.id) });
      setBusy(false);
    }}>
      <h2 className="text-sm font-semibold text-body">Choose what your site runs</h2>
      <p className="text-sm text-secondary">Each part can be switched on or off later in the Admin Panel. A part you switch on gets its own setup page next.</p>
      {mods.length === 0 && <p className={hint}>No optional parts in this release.</p>}
      {mods.map((m) => (
        <div key={m.id} className="flex items-start gap-3 rounded-md border border-edge p-2">
          <Toggle on={!!on[m.id]} onToggle={() => setOn({ ...on, [m.id]: !on[m.id] })} label={m.label} />
          <div className="min-w-0">
            <p className="text-xs font-medium text-body">{m.label}</p>
            <p className={hint}>{m.description}</p>
          </div>
        </div>
      ))}
      {core.length > 0 && (
        <div className="space-y-2 border-t border-edge pt-3">
          <p className="text-xs font-medium text-body">Where you stream, and other services</p>
          <p className={hint}>Each one you tick gets its own page next, with what to paste where. A platform is read as soon as its channel is set; untick it to leave it out of setup (the Admin Panel still has it).</p>
          {core.map((c) => (
            <div key={c.id} className="flex items-start gap-3 rounded-md border border-edge p-2">
              <Toggle on={!!chosen[c.id]} onToggle={() => setChosen({ ...chosen, [c.id]: !chosen[c.id] })} label={c.label} />
              <div className="min-w-0">
                <p className="text-xs font-medium text-body">{c.label}</p>
                <p className={hint}>{c.description}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      {later.length > 0 && (
        <div className="space-y-1 border-t border-edge pt-3">
          <p className="text-xs font-medium text-body">Coming in a later release</p>
          {later.map((c) => <p key={c.id} className={hint}><span className="text-body">{c.label}:</span> {c.description} Until then they are set in the Admin Panel.</p>)}
        </div>
      )}
      <Nav back={back} onBack={onBack} busy={busy} />
    </form>
  );
}

/** The payment pages, and the step on each whose fields take the keys that move live money. */
const PAYMENT_KEY_STEP: Record<string, { provider: string; step: string }> = {
  "module:stripe": { provider: "Stripe", step: "keys" },
  "module:paypal": { provider: "PayPal", step: "app" },
};

/** Before the live keys: what a paying viewer can see about the operator. A warning, never a gate —
 *  no checkbox, no "checked" value, nothing saved (k, 2026-10-19). The words are the product form
 *  of the docs page "Protect your personal name and home address"; the wizard links no docs
 *  pages, so this does not either. */
function PaymentIdentityWarning({ provider }: { provider: string }) {
  return (
    <section role="note" data-setup-warning="payment-identity" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
      <h3 className="text-sm font-semibold text-amber-300">Before you take real money: your name and home address</h3>
      <p className="text-sm text-secondary">
        When a viewer pays you, {provider} can show them the business details on your {provider} account: its public business
        name, support address, phone and email, and the name on their card statement. If you gave the account your legal name
        or your home address as those details, a paying viewer can see them.
      </p>
      <p className="text-sm text-secondary">
        This site cannot change what {provider} prints on receipts, invoices or statements, and the Test buttons on this page
        do not look at any of them.
      </p>
      <p className="text-sm text-secondary">
        So before you paste live keys: in test mode, make one payment of each kind and look at the account&apos;s public
        details, a receipt, an invoice and the statement name as a stranger would. Change anything personal at {provider} to
        accurate details it allows. Then switch to live keys, and check your first real statement line too.
      </p>
    </section>
  );
}

function ModulePage({ stepId, data, back, onBack, save }: { stepId: string; data: Json; back: boolean; onBack: () => void; save: (d: Json) => Promise<void> }) {
  const page = data.page as SetupPage | null;
  const isSet = (data.isSet as Record<string, boolean>) ?? {};
  const [values, setValues] = useState<Record<string, string>>((data.values as Record<string, string>) ?? {});
  const [skipped, setSkipped] = useState<string[]>(((data.skipped as string[]) ?? []).map((s) => s.split(":")[1] ?? ""));
  const [tests, setTests] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!page) return <section className={card}><p className={hint}>This module has no setup page.</p><Nav back={back} onBack={onBack} busy={false} /></section>;
  const payment = PAYMENT_KEY_STEP[stepId];
  const test = async (key: string) => {
    setTests({ ...tests, [key]: "testing…" });
    // The test reads what is stored, so the fields are saved first (without moving on).
    const saved = await call("/api/setup/step", { step: stepId, data: { values, skipped }, stay: true });
    if (!saved.ok) { setTests({ ...tests, [key]: errorOf(saved.json) }); return; }
    const r = await call("/api/setup/test", { key });
    const results = (r.json.results as { package: string; ok: boolean; detail: string }[] | undefined) ?? [];
    setTests({ ...tests, [key]: r.ok ? results.map((x) => `${x.ok ? "✓" : "✗"} ${x.detail}`).join(" · ") || "no result" : errorOf(r.json) });
  };
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault(); setErr(null);
      const missing = page.steps.filter((s) => s.need === "required" && !skipped.includes(s.id) && s.fields.some((f) => !isSet[f.key] && !(values[f.key] ?? "").trim()));
      if (missing.length) { setErr(`fill "${missing[0]!.title}", or tick "skip for now"`); return; }
      setBusy(true); await save({ values, skipped }); setBusy(false);
    }}>
      <section className={card}>
        <h2 className="text-sm font-semibold text-body">{page.label}</h2>
        <p className="text-sm text-secondary">{page.description}</p>
      </section>
      {page.steps.map((s) => (
        <Fragment key={s.id}>
        {payment?.step === s.id && <PaymentIdentityWarning provider={payment.provider} />}
        <section className={card}>
          <SetupStepGuide step={s} />
          {s.fields.map((f) => (
            <div key={f.key} className="space-y-1">
              <label className={label} htmlFor={`bb-${f.key}`}>{f.label}</label>
              {f.values?.length ? (
                <select id={`bb-${f.key}`} className={input} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                  <option value="">—</option>
                  {f.values.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              ) : (
                <input id={`bb-${f.key}`} className={input} type={f.secret ? "password" : "text"} autoComplete="off"
                  placeholder={f.secret && isSet[f.key] ? "saved — type to replace" : ""}
                  value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
              )}
              <p className={hint}>{f.description}</p>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            {s.test && <button type="button" className={btn} onClick={() => void test(s.test!)}>Test</button>}
            {s.test && tests[s.test] && <span className="text-2xs text-secondary">{tests[s.test]}</span>}
            <label className="ml-auto flex items-center gap-1.5 text-2xs text-muted">
              <input type="checkbox" checked={skipped.includes(s.id)} onChange={(e) => setSkipped(e.target.checked ? [...skipped, s.id] : skipped.filter((x) => x !== s.id))} />
              skip for now (stays on the Admin Panel&apos;s list)
            </label>
          </div>
        </section>
        </Fragment>
      ))}
      <Problem text={err} />
      <section className={card}><Nav back={back} onBack={onBack} busy={busy} /></section>
    </form>
  );
}

/** "Who can join?" — the sign-up switch (matrix.registration). No answer is preselected: the page asks. */
const JOIN_CHOICES = [
  { id: "open", title: "Anyone", blurb: "open sign-up: anyone can make an account on this site and join the community." },
  { id: "closed", title: "Only accounts I make", blurb: "closed: nobody can make a new account here on their own — an admin makes them." },
] as const;

function Community({ data, back, onBack, save }: { data: Json; back: boolean; onBack: () => void; save: (d: Json) => Promise<void> }) {
  const [federation, setFederation] = useState(!!data.federation);
  const [registration, setRegistration] = useState<string | null>(typeof data.registration === "string" ? data.registration : null);
  const [rooms, setRooms] = useState<{ hub: string | null; general: string | null }>({ hub: (data.hub as string) ?? null, general: (data.general as string) ?? null });
  const [state, setState] = useState<"idle" | "working" | "done">(data.hub && data.general ? "done" : "idle");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  const make = async () => {
    setErr(null); setState("working");
    const r = await call("/api/setup/community", { federation, registration });
    if (!r.ok) { setErr(errorOf(r.json)); setState("idle"); return; }
    const asked = String(r.json.requestedAt);
    timer.current = setInterval(async () => {
      const s = await call("/api/setup/community");
      if (!s.ok) return;
      const result = s.json.result as { ok: boolean; at: string; message: string } | null;
      if (s.json.hub && s.json.general && (!result || Date.parse(result.at) >= Date.parse(asked))) {
        clearInterval(timer.current!); setRooms({ hub: s.json.hub as string, general: s.json.general as string }); setState("done");
      } else if (result && Date.parse(result.at) >= Date.parse(asked) && !result.ok) {
        clearInterval(timer.current!); setErr(`the server could not make the community: ${result.message}`); setState("idle");
      }
    }, 2000);
  };
  return (
    <form className={card} onSubmit={async (e) => { e.preventDefault(); setBusy(true); await save(registration ? { registration } : {}); setBusy(false); }}>
      <h2 className="text-sm font-semibold text-body">Your community</h2>
      <p className="text-sm text-secondary">
        The site&apos;s chat community lives on its own homeserver: a space for your community and a <span className="text-body">#general</span> room, made as your account so they are yours.
      </p>
      <div className="flex items-start gap-3 rounded-md border border-edge p-2">
        <Toggle on={federation} onToggle={() => setFederation(!federation)} label="Federation" disabled={state !== "idle"} />
        <div className="min-w-0">
          <p className="text-xs font-medium text-body">Federation</p>
          <p className={hint}>Off: only accounts on this site take part. On: people with accounts on other Matrix servers can join too. You can switch it on later at no cost — the server name ({String(data.serverName ?? "")}) never changes.</p>
        </div>
      </div>
      <fieldset className="space-y-1 rounded-md border border-edge p-2">
        <legend className="px-1 text-xs font-medium text-body">Who can join?</legend>
        <div className="space-y-1" role="radiogroup" aria-label="Who can join">
          {JOIN_CHOICES.map((c) => (
            <label key={c.id} className="flex items-start gap-2 text-xs text-body">
              <input type="radio" name="bb-join" className="mt-0.5" checked={registration === c.id} onChange={() => setRegistration(c.id)} />
              <span><span className="font-medium">{c.title}</span> <span className={hint}>— {c.blurb}</span></span>
            </label>
          ))}
        </div>
        <p className={hint}>Sign-up stays closed until setup is finished, then follows this. You can change it later in the Admin Panel.</p>
      </fieldset>
      {state === "done" ? (
        <p className="text-xs text-body">✓ Community made — the space and #general exist, and your account is in both.</p>
      ) : (
        <button type="button" className={btn} onClick={() => void make()} disabled={state === "working" || data.hostRequests === false || !registration}>
          {state === "working" ? "Making the community… (up to a minute)" : "Make the community"}
        </button>
      )}
      {data.hostRequests === false && <p className={hint}>This install cannot ask its server for this; run <code className="text-body">blackbranch matrix bootstrap</code> there.</p>}
      {rooms.general && <p className={`${hint} break-all`}>#general: {rooms.general}</p>}
      <Problem text={err} />
      <Nav back={back} onBack={onBack} busy={busy} disabled={state !== "done" || !registration} />
    </form>
  );
}

type HostAnswer = { ok: boolean; at: string; message: string } | null;
const BACKUP_CHOICES = [
  { id: "local", title: "This server", blurb: "A folder on this server. Simple — but a backup on the same disk does not survive losing the server. Add a bucket later in the Admin Panel." },
  { id: "s3", title: "A storage bucket", blurb: "Any S3-compatible bucket: Backblaze B2, Cloudflare R2, Wasabi, Amazon S3…" },
  { id: "sftp", title: "Another server (SFTP)", blurb: "A folder on another machine you can reach over SSH." },
] as const;

/** Where backups go, and the test that must pass before Finish: one backup, then a restore of it
 *  into a scratch database on the server (nothing live is touched). */
function Backups({ data, onPassed }: { data: Json; onPassed: (passed: boolean) => void }) {
  const saved = (data.backup as { target?: string; repository?: string; region?: string }) ?? {};
  const [target, setTarget] = useState<string>(saved.target ?? "local");
  const [repository, setRepository] = useState(saved.repository ?? "");
  const [region, setRegion] = useState(saved.region ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [state, setState] = useState<"idle" | "testing" | "passed">("idle");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  // Back on this page: a test that already passed for the saved target still counts.
  useEffect(() => {
    void call("/api/setup/backup").then((s) => {
      if (s.ok && s.json.passed === true) { setState("passed"); onPassed(true); }
      if (s.ok && typeof s.json.publicKey === "string") setPublicKey(s.json.publicKey);
    });
  }, [onPassed]);
  const changed = () => { if (state === "passed") { setState("idle"); onPassed(false); } };
  const poll = (until: (j: Json) => boolean) => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const s = await call("/api/setup/backup");
      if (s.ok && until(s.json)) clearInterval(timer.current!);
    }, 3000);
  };
  const test = async () => {
    setErr(null); setState("testing"); onPassed(false);
    const r = await call("/api/setup/backup", { target, repository, region, accessKeyId, secretAccessKey });
    if (!r.ok) { setErr(errorOf(r.json)); setState("idle"); return; }
    const asked = String(r.json.requestedAt);
    poll((j) => {
      const result = j.result as HostAnswer;
      if (!result || Date.parse(result.at) < Date.parse(asked)) return false;
      if (j.passed === true) { setState("passed"); onPassed(true); } else { setErr(`the test backup did not pass: ${result.message.replace(/^.*?\b(BACKUP|VERIFY) FAILED: /, "")}`); setState("idle"); }
      return true;
    });
  };
  const askKey = async () => {
    setErr(null);
    const r = await call("/api/setup/backup", { key: true });
    if (!r.ok) { setErr(errorOf(r.json)); return; }
    const asked = String(r.json.requestedAt);
    poll((j) => {
      const kr = j.keyResult as HostAnswer;
      if (!kr || Date.parse(kr.at) < Date.parse(asked)) return false;
      if (typeof j.publicKey === "string") setPublicKey(j.publicKey); else setErr(`the server could not make its key: ${kr.message}`);
      return true;
    });
  };
  const testing = state === "testing";
  return (
    <fieldset className="space-y-2 rounded-md border border-edge p-2" disabled={testing}>
      <legend className="px-1 text-xs font-medium text-body">Backups</legend>
      <p className={hint}>Every night at the quiet hour the server backs up the database, the chat server&apos;s files and its keys, locked with your recovery sheet&apos;s passphrase. Once a week it checks that the newest backup really restores.</p>
      <div className="space-y-1" role="radiogroup" aria-label="Where backups go">
        {BACKUP_CHOICES.map((c) => (
          <label key={c.id} className="flex items-start gap-2 text-xs text-body">
            <input type="radio" name="bb-backup-target" className="mt-0.5" checked={target === c.id} onChange={() => { setTarget(c.id); changed(); }} />
            <span><span className="font-medium">{c.title}</span> <span className={hint}>— {c.blurb}</span></span>
          </label>
        ))}
      </div>
      {target !== "local" && (
        <div className="space-y-1">
          <label className={label} htmlFor="bb-backup-repo">Address</label>
          <input id="bb-backup-repo" className={input} value={repository} spellCheck={false} autoComplete="off"
            placeholder={target === "s3" ? "s3:https://s3.us-west-004.backblazeb2.com/my-bucket" : "sftp:backup@203.0.113.7:/srv/backups/site"}
            onChange={(e) => { setRepository(e.target.value); changed(); }} />
        </div>
      )}
      {target === "s3" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <label className={label} htmlFor="bb-backup-akid">Access key id</label>
            <input id="bb-backup-akid" className={input} value={accessKeyId} autoComplete="off" spellCheck={false} placeholder="leave empty to keep the saved one" onChange={(e) => { setAccessKeyId(e.target.value); changed(); }} />
          </div>
          <div className="space-y-1">
            <label className={label} htmlFor="bb-backup-secret">Secret key</label>
            <input id="bb-backup-secret" type="password" className={input} value={secretAccessKey} autoComplete="new-password" placeholder="leave empty to keep the saved one" onChange={(e) => { setSecretAccessKey(e.target.value); changed(); }} />
          </div>
          <div className="space-y-1">
            <label className={label} htmlFor="bb-backup-region">Region <span className={hint}>(if the provider asks; R2: auto)</span></label>
            <input id="bb-backup-region" className={input} value={region} spellCheck={false} onChange={(e) => { setRegion(e.target.value); changed(); }} />
          </div>
        </div>
      )}
      {target === "sftp" && (
        <div className="space-y-1">
          <p className={hint}>Add this server&apos;s key to the account on the other machine (its <code className="text-body">~/.ssh/authorized_keys</code>), then run the test.</p>
          {publicKey
            ? <pre className="whitespace-pre-wrap break-all rounded-md bg-surface-2 p-2 text-2xs text-body">{publicKey}</pre>
            : <button type="button" className={btn} onClick={() => void askKey()}>Show this server&apos;s key</button>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={() => void test()} disabled={testing || data.hostRequests === false}>
          {testing ? "Backing up and checking it restores… (a minute or two)" : state === "passed" ? "Run the test again" : "Run a test backup"}
        </button>
        {state === "passed" && <span className="text-xs text-body">✓ A backup was made and restored on the server.</span>}
      </div>
      {data.hostRequests === false && <p className={hint}>This install cannot ask its server for a backup; run <code className="text-body">blackbranch backup</code> there.</p>}
      <Problem text={err} />
    </fieldset>
  );
}

type Signup = { state: string; words: string; place: string; label: string };

/** Who can join, and where that changes: on the Finish page and once setup is done. */
function SignupLine({ signup }: { signup: Signup | undefined }) {
  if (!signup) return null;
  return (
    <div className="space-y-0.5 rounded-md border border-edge p-2">
      <p className="text-xs font-medium text-body">Who can join</p>
      <p className="text-xs text-body">{signup.words}</p>
      <p className={hint}>To change it: {signup.place} → <span className="text-body">{signup.label}</span>.</p>
    </div>
  );
}

function Finish({ data, back, onBack, siteName }: { data: Json; back: boolean; onBack: () => void; siteName: string }) {
  const [backupPassed, setBackupPassed] = useState(false);
  const [wake, setWake] = useState("");
  const [quietTopic, setQuietTopic] = useState("");
  const signup = data.signup as Signup | undefined;
  const alerts = (data.alerts as { set: { wake: boolean; quiet: boolean } | null; words: string } | undefined) ?? null;
  const [quiet, setQuiet] = useState<number>(typeof data.quietHour === "number" ? data.quietHour : 4);
  const [reports, setReports] = useState(!!data.bugReports);
  const [phase, setPhase] = useState<"form" | "applying" | "done">("form");
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  const pending = (data.pending as string[]) ?? [];

  const waitForRestart = (asked: string) => {
    timer.current = setInterval(async () => {
      // The site restarts with its new values mid-way: a failed poll is expected, not an error.
      const s = await call("/api/setup/finish");
      if (!s.ok) return;
      const result = s.json.result as { ok: boolean; at: string; message: string } | null;
      if (Array.isArray(s.json.pending) && s.json.pending.length === 0) {
        clearInterval(timer.current!);
        const c = await call("/api/setup/finish", { complete: true });
        if (c.ok) setPhase("done"); else { setErr(errorOf(c.json)); setPhase("form"); }
      } else if (result && Date.parse(result.at) >= Date.parse(asked) && !result.ok) {
        clearInterval(timer.current!); setErr(`the values were not applied: ${result.message}`); setPhase("form");
      }
    }, 3000);
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    const r = await call("/api/setup/finish", { quietHour: quiet, bugReports: reports, alerts: { wake, quiet: quietTopic } });
    if (!r.ok) { setErr(errorOf(r.json)); return; }
    if (r.json.phase === "done") { setPhase("done"); return; }
    setPhase("applying");
    waitForRestart(String(r.json.requestedAt));
  };
  if (phase === "done") {
    return (
      <section className={card}>
        <h2 className="text-sm font-semibold text-body">Your site is ready</h2>
        <p className="text-sm text-secondary">Setup is finished. Everything here can be changed later in the Admin Panel.</p>
        <SignupLine signup={signup} />
        <Link className={`${primary} inline-flex items-center`} href="/" prefetch={false}>Open the site</Link>
      </section>
    );
  }
  if (phase === "applying") {
    return (
      <section className={card}>
        <h2 className="text-sm font-semibold text-body">Applying your site&apos;s details</h2>
        <p className="text-sm text-secondary">The site is restarting with its new name and details ({pending.join(", ") || "your values"}). This takes under a minute; the page may blink once while it comes back.</p>
        <p className={hint}>Keep this page open.</p>
      </section>
    );
  }
  return (
    <form className={card} onSubmit={submit}>
      <h2 className="text-sm font-semibold text-body">Last details</h2>
      <div className="space-y-1">
        <label className={label} htmlFor="bb-quiet">Quiet hour</label>
        <select id="bb-quiet" className={`${FIELD} px-2 text-xs`} value={quiet} onChange={(e) => setQuiet(Number(e.target.value))}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
        </select>
        <p className={hint}>When backups and security updates run each day, in your site&apos;s time zone — pick an hour you are never live.</p>
      </div>
      <label className="flex items-start gap-2 text-xs text-body">
        <input type="checkbox" className="mt-0.5" checked={reports} onChange={(e) => setReports(e.target.checked)} />
        <span>Send bug reports to the project <span className={hint}>— off unless you tick it. A report never holds a secret, chat text or a viewer&apos;s id.</span></span>
      </label>
      <SignupLine signup={signup} />
      <fieldset className="space-y-2 rounded-md border border-edge p-2">
        <legend className="px-1 text-xs font-medium text-body">Phone alerts <span className={hint}>(optional)</span></legend>
        <p className={hint}>{alerts?.words}</p>
        <p className={hint}>To have problems pushed to your phone, make two private topics in the <a className="underline" href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a> app — one for urgent problems, one for the rest — and paste their full addresses. Anyone who knows a topic&apos;s address can read it: make the names long and unguessable. Leave both empty to skip.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <label className={label} htmlFor="bb-alert-wake">Urgent topic</label>
            <input id="bb-alert-wake" type="password" className={input} value={wake} autoComplete="off" spellCheck={false}
              placeholder={alerts?.set?.wake ? "leave empty to keep the saved one" : "https://ntfy.sh/…"} onChange={(e) => setWake(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className={label} htmlFor="bb-alert-quiet">Quiet topic</label>
            <input id="bb-alert-quiet" type="password" className={input} value={quietTopic} autoComplete="off" spellCheck={false}
              placeholder={alerts?.set?.quiet ? "leave empty to keep the saved one" : "https://ntfy.sh/…"} onChange={(e) => setQuietTopic(e.target.value)} />
          </div>
        </div>
      </fieldset>
      <Backups data={data} onPassed={setBackupPassed} />
      {pending.length > 0 && <p className={hint}>Finishing restarts the site once with your new name and details — under a minute.</p>}
      {!backupPassed && data.hostRequests !== false && <p className={hint}>Finish opens once a test backup has passed.</p>}
      <Problem text={err} />
      <Nav back={back} onBack={onBack} busy={false} next={`Finish setting up ${siteName}`} disabled={!backupPassed && data.hostRequests !== false} />
    </form>
  );
}

function Wizard({ view, siteName: builtName }: { view: Extract<SetupView, { phase: "wizard" }>; siteName: string }) {
  const { step, order, data } = view;
  // On the last page the running site may still hold the old name (it changes when Finish restarts
  // the site with the new values): show the name that was typed, so "Your site is ready" sits under the right one.
  const siteName = typeof data.stagedName === "string" && data.stagedName ? data.stagedName : builtName;
  const [err, setErr] = useState<string | null>(null);
  const idx = order.indexOf(step);
  const prev = previousStep(step, order);
  const back = !!prev;
  const router = useRouter();
  // The server decides the next page: re-render this route from it.
  const reload = () => router.refresh();
  const save = async (d: Json) => {
    setErr(null);
    const r = await call("/api/setup/step", { step, data: d });
    if (r.ok) reload(); else setErr(errorOf(r.json));
  };
  const onBack = async () => {
    if (!prev) return;
    const r = await call("/api/setup/step", { goto: prev });
    if (r.ok) reload(); else setErr(errorOf(r.json));
  };
  const values = (data.values as Record<string, string>) ?? {};
  let body: React.ReactNode;
  if (step === "recovery") body = <Recovery save={save} />;
  else if (step === "site") {
    body = <FieldsForm title="Your site" back={back} onBack={onBack} save={save} values={values} fields={(data.fields as FormField[]) ?? []}
      intro={<>What people see as your site&apos;s name and details. The legal details fill your Terms and Privacy pages. Your site is built with these when you finish.</>}
      footer={<p className={`${hint} border-t border-edge pt-3`}>The site&apos;s address ({String(data.domain ?? "")}) and the community&apos;s server name ({String(data.serverName ?? "")}) are permanent: they cannot be changed later. Everything on this page can.</p>} />;
  } else if (step === "points") {
    body = <FieldsForm title="Points" back={back} onBack={onBack} save={save} values={values} fields={(data.fields as FormField[]) ?? []}
      intro={<>Your community earns points for taking part. Name them — leave a field empty for the built-in word.</>} />;
  } else if (step === "modules") body = <Modules data={data} back={back} onBack={onBack} save={save} />;
  else if (step.startsWith("module:") || step.startsWith("core:")) body = <ModulePage key={step} stepId={step} data={data} back={back} onBack={onBack} save={save} />;
  else if (step === "community") body = <Community data={data} back={back} onBack={onBack} save={save} />;
  else if (step === "finish") body = <Finish data={data} back={back} onBack={onBack} siteName={siteName} />;
  return (
    <Shell siteName={siteName} step={{ n: idx + 1, of: order.length, title: titleOf(step) }}>
      <div key={step}>{body}</div>
      <Problem text={err} />
      <p className={hint}>Signed in as {view.me}. Each page is saved as you go — you can close this and come back.</p>
    </Shell>
  );
}

/** The whole /setup page. */
export function SetupWizard({ view, siteName, serverName, domain, token }: {
  view: SetupView; siteName: string; serverName: string; domain: string; token: string | null;
}) {
  // The token leaves the address bar at once (history, screenshots); this page keeps it in memory.
  useEffect(() => {
    if (token && window.location.search.includes("token=")) window.history.replaceState(null, "", "/setup");
  }, [token]);
  if (view.phase === "closed") {
    return (
      <Shell siteName={siteName}>
        <section className={card}>
          <h2 className="text-sm font-semibold text-body">Setup is finished</h2>
          <p className="text-sm text-secondary">This site is set up. Its settings are in the Admin Panel.</p>
          <Link className={btn + " inline-flex items-center"} href="/" prefetch={false}>Go to the site</Link>
        </section>
      </Shell>
    );
  }
  if (view.phase === "wizard") return <Wizard view={view} siteName={siteName} />;
  if (view.phase === "unavailable" || (view.phase === "token" && token && view.linkOk === null)) {
    return (
      <Shell siteName={siteName}>
        <section className={card}>
          <h2 className="text-sm font-semibold text-body">Cannot check right now</h2>
          <p className="text-sm text-secondary">The site cannot read its settings at the moment, so it cannot tell whether this site is set up. Try again in a moment.</p>
        </section>
      </Shell>
    );
  }
  if (view.phase === "token" && token) {
    if (!view.linkOk) {
      return (
        <Shell siteName={siteName}>
          <section className={card}>
            <h2 className="text-sm font-semibold text-body">{view.adminExists ? "This setup link no longer works" : "This setup link is not valid"}</h2>
            <p className="text-sm text-secondary">{view.adminExists
              ? "The site's first admin account exists, so its setup link is used up. Sign in with that account to carry on."
              : "Check the link the installer printed. On the server, blackbranch setup-link prints it again."}</p>
          </section>
          {view.adminExists && <NotYou adminExists />}
        </Shell>
      );
    }
    return (
      <Shell siteName={siteName} step={{ n: 1, of: view.of, title: "Your account" }}>
        <FirstAdmin token={token} serverName={serverName} domain={domain} />
      </Shell>
    );
  }
  return <Shell siteName={siteName}><NotYou adminExists={view.phase === "signin" && view.adminExists} /></Shell>;
}
