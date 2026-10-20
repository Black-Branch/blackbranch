"use client";

// Settings → Privacy → Delete my account. The server re-checks everything
// (app/lib/accountDeletion.ts); this screen exists to say plainly what goes, what is kept, and
// what it needs first: a fresh sign-in, the account name typed, no active subscription.

import { useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import { signOutEverything } from "@/app/lib/signOutEverything";
import { siteName } from "@/app/lib/siteName";

type Check = { accountName: string; signedInAt: string | null; fresh: boolean; activeSubscription: boolean; banned: boolean; banEndsAt?: string | null; openCases: { mark: boolean; held: boolean; report: boolean }; matrixErase: "automatic" | "operator" | "elsewhere" };

const REMOVED = [
  "your profile: name, picture, banner, bio, colours and settings",
  "badges and styles shown on your name",
  "linked platform accounts and the sign-in tokens stored for them",
  "your messages here, and our copies of what your linked platform accounts said (the lines stay as “deleted” so conversations still read in order)",
  "what the AI remembers about you",
  "votes, points balance and support conversations",
];
const KEPT = [
  "payment records the law requires us to keep — amount, date and the payment processor's reference, with your name and message removed",
  "moderation records — bans, reports, review notes and the mod log; a ban stays on the account and on its linked platform accounts, so deleting does not lift it",
  "while moderators have an open case about you (a report, a held message, a mark or a ban): the words of your messages, for moderators only, without your profile",
];

export default function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function start() {
    setOpen(true);
    setError(null);
    try { setCheck(await getJson<Check>("/api/me/delete-account", { cache: "no-store" })); }
    catch { setError("Couldn't load this — try again."); }
  }
  async function remove() {
    setBusy(true);
    setError(null);
    const res = await postJson("/api/me/delete-account", { name: typed }).catch(() => null);
    const d = (await res?.json().catch(() => null)) as { error?: string; matrix?: string } | null;
    setBusy(false);
    if (!res?.ok) { setError(d?.error ?? "Couldn't delete — try again."); return; }
    setDone(d?.matrix === "erased" ? "Your account is deleted, and your Matrix chat account with it."
      : d?.matrix === "elsewhere" ? "Your account here is deleted. Your Matrix account belongs to another server — delete it there."
      : "Your account is deleted. Your Matrix chat account is removed by the site's operator.");
    setTimeout(() => signOutEverything(), 4000);
  }

  if (done) return <p role="status" className="px-1 text-sm text-body">{done} Signing you out…</p>;
  if (!open) {
    return (
      <div className="px-1 pt-3 border-t border-edge">
        <button type="button" onClick={() => void start()} className="text-sm text-red-300 hover:text-red-200 underline">Delete my account…</button>
      </div>
    );
  }
  const name = check?.accountName ?? "";
  return (
    <div className="px-1 pt-3 border-t border-edge space-y-2 text-xs" aria-label="Delete my account">
      <p className="text-sm font-semibold text-body">Delete my account</p>
      <p className="text-secondary">This happens at once and cannot be undone. Deleted:</p>
      <ul className="list-disc pl-5 space-y-0.5 text-body-dim">{REMOVED.map((r) => <li key={r}>{r}</li>)}</ul>
      <p className="text-secondary">Kept:</p>
      <ul className="list-disc pl-5 space-y-0.5 text-body-dim">{KEPT.map((r) => <li key={r}>{r}</li>)}</ul>
      {check && (
        <p className="text-muted">
          {check.matrixErase === "automatic" ? "Your Matrix chat account (DMs, community rooms) is deactivated and erased too."
            : check.matrixErase === "elsewhere" ? "You signed in with a Matrix account from another server — this site cannot delete it; do that there."
            : `Your Matrix chat account is removed by ${siteName()}'s operator after this.`}
        </p>
      )}
      {!check ? (
        <p role="status" className="text-muted">{error ?? "Checking…"}</p>
      ) : check.activeSubscription ? (
        <p className="text-amber-300">You have an active subscription. Cancel it first (it stops future charges), then come back here.</p>
      ) : !check.fresh ? (
        <div className="space-y-1">
          <p className="text-amber-300">For your safety, sign in again first — deleting needs a sign-in from the last 15 minutes.</p>
          <a href="/auth/signin" className="inline-block rounded border border-edge px-2 py-1 text-body hover:bg-surface-1">Sign in again</a>
        </div>
      ) : (
        <form className="space-y-2" onSubmit={(ev) => { ev.preventDefault(); void remove(); }}>
          <label className="block text-secondary">Type <span className="font-mono text-body">{name}</span> to confirm
            <input className="mt-1 block w-full rounded-lg border border-edge bg-surface-1 px-3 py-1.5 text-sm text-body outline-none focus:border-edge-strong"
              value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Your account name" />
          </label>
          {error && <p role="alert" className="text-red-300">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy || typed.trim().toLowerCase() !== name.toLowerCase()}
              className="rounded-lg border border-red-400/50 px-3 py-1.5 text-sm font-medium text-red-200 hover:bg-red-900/30 disabled:opacity-40">
              {busy ? "Deleting…" : "Delete my account"}
            </button>
            <button type="button" onClick={() => { setOpen(false); setTyped(""); }} className="rounded-lg border border-edge px-3 py-1.5 text-sm text-body hover:bg-surface-1">Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
