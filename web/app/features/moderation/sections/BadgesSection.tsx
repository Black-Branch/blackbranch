"use client";

import { useRef, useState } from "react";
import { useBadges } from "@/app/lib/BadgesContext";
import { postJson } from "@/app/lib/http";
import { currencyName } from "@/app/lib/currency";
import { card, h2 } from "../shared";

// Admin-only badge authoring — here, not in the viewer-facing chat settings
// (it does not belong next to a viewer's own theme controls). Still
// self-gated (renders nothing for non-admins) as a second line of defence
// behind ModPanel's `isAdmin` check. Create a badge by uploading a small image
// (stored as a data: URL — badges are tiny icons) and a name; delete removes
// the def. ★ designates the Supporter badge, 🛡 the fixed mod badge. Users
// equip their own unlocked badges (BadgeSlots) — no hand-assign.
const MAX_BYTES = 64 * 1024; // pre-base64 file size cap

export default function BadgesSection() {
  const badges = useBadges();
  const [name, setName] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  if (!badges.isAdmin) return null;

  function pickFile(file: File | undefined) {
    setErr("");
    if (!file) return;
    if (!file.type.startsWith("image/")) { setErr("Not an image"); return; }
    if (file.size > MAX_BYTES) { setErr("Image too large (max 64KB)"); return; }
    const reader = new FileReader();
    reader.onload = () => setImageUrl(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => setErr("Could not read file");
    reader.readAsDataURL(file);
  }

  async function create() {
    if (!name.trim() || !imageUrl || busy) return;
    setBusy(true);
    setErr("");
    const res = await postJson("/api/badges", { name: name.trim(), imageUrl }).catch(() => null);
    setBusy(false);
    if (!res || !res.ok) { setErr("Save failed"); return; }
    setName(""); setImageUrl("");
    if (fileRef.current) fileRef.current.value = "";
    badges.refresh();
  }

  async function remove(id: number) {
    setErr("");
    const res = await postJson(`/api/badges?id=${id}`, undefined, "DELETE").catch(() => null);
    if (!res || !res.ok) { setErr("Delete failed"); return; }
    badges.refresh();
  }

  // Make this badge the one Supporters wear. The server moves the flag and
  // re-equips every current Supporter to it.
  async function setSubBadge(id: number) {
    if (busy) return;
    setBusy(true);
    setErr("");
    const res = await postJson(`/api/badges?id=${id}`, { subscriber: true }, "PATCH").catch(() => null);
    setBusy(false);
    if (!res || !res.ok) { setErr("Couldn’t set Supporter badge"); return; }
    badges.refresh();
  }

  // Designate the fixed mod badge (shown off-slot for every mod).
  async function setModBadge(id: number) {
    if (busy) return;
    setBusy(true);
    setErr("");
    const res = await postJson(`/api/badges?id=${id}`, { mod: true }, "PATCH").catch(() => null);
    setBusy(false);
    if (!res || !res.ok) { setErr("Couldn’t set mod badge"); return; }
    badges.refresh();
  }

  // Price a badge in the coin store (unlock_criteria, v67) — prompt-driven to
  // keep the chip row compact; empty/0 takes it off sale.
  async function setPrice(id: number, current: number | null | undefined) {
    if (busy) return;
    const raw = window.prompt(
      `Store price in ${currencyName()} (1 = 1¢). Empty or 0 removes it from the store.`,
      current ? String(current) : ""
    );
    if (raw === null) return;
    const n = Math.round(Number(raw));
    const coinPrice = raw.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
    setBusy(true);
    setErr("");
    const res = await postJson(`/api/badges?id=${id}`, { coinPrice }, "PATCH").catch(() => null);
    setBusy(false);
    if (!res || !res.ok) { setErr("Couldn’t set the price"); return; }
    badges.refresh();
  }

  return (
    <section className={card}>
      <h2 className={h2}>Badges</h2>
      <div className="space-y-2">
        {badges.catalog.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {badges.catalog.map((b) => (
              <div
                key={b.id}
                className={`flex items-center gap-1 px-1.5 py-1 rounded text-2xs text-body-dim ${
                  b.isSubscriber ? "bg-amber-500/15 ring-1 ring-amber-500/40"
                    : b.isMod ? "bg-emerald-500/15 ring-1 ring-emerald-500/40"
                    : "bg-surface-1"
                }`}
              >
                <img src={b.imageUrl} alt="" className="h-4 w-auto" />
                <span className="truncate max-w-[90px]">{b.name}</span>
                <button
                  type="button"
                  onClick={() => setSubBadge(b.id)}
                  disabled={busy || b.isSubscriber}
                  title={b.isSubscriber ? "Current Supporter badge" : "Make this the Supporter badge"}
                  className={`ml-0.5 transition-colors ${
                    b.isSubscriber ? "text-amber-400 cursor-default" : "text-muted hover:text-amber-300"
                  }`}
                >
                  ★
                </button>
                <button
                  type="button"
                  onClick={() => setModBadge(b.id)}
                  disabled={busy || b.isMod}
                  title={b.isMod ? "Current mod badge" : "Make this the mod badge"}
                  className={`transition-colors ${
                    b.isMod ? "text-emerald-400 cursor-default" : "text-muted hover:text-emerald-300"
                  }`}
                >
                  🛡
                </button>
                <button
                  type="button"
                  onClick={() => setPrice(b.id, b.coinPrice)}
                  disabled={busy || !!b.isSubscriber || !!b.isMod}
                  title={
                    b.isSubscriber || b.isMod ? "Subscriber/mod badges can't be sold"
                    : b.coinPrice ? `In the store: ${b.coinPrice} ${currencyName(b.coinPrice)} — click to change`
                    : "Put in the coin store"
                  }
                  className={`transition-colors ${
                    b.coinPrice ? "text-yellow-400 hover:text-yellow-300" : "text-muted hover:text-yellow-300"
                  } disabled:opacity-30`}
                >
                  $
                </button>
                <button
                  type="button"
                  onClick={() => remove(b.id)}
                  title={`Delete "${b.name}"`}
                  className="text-muted hover:text-red-300 transition-colors"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1.5">
          {imageUrl ? (
            <img src={imageUrl} alt="" className="h-6 w-auto rounded bg-surface-1 p-0.5" />
          ) : null}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="px-2 py-1 rounded text-2xs bg-surface-1 hover:bg-surface-3 border border-edge text-body-dim transition-colors shrink-0"
          >
            {imageUrl ? "Change image" : "Upload image"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Badge name"
            maxLength={60}
            className="flex-1 min-w-0 bg-control text-body text-xs rounded px-2 py-1 border border-control"
          />
          <button
            type="button"
            onClick={create}
            disabled={!name.trim() || !imageUrl || busy}
            className="px-2 py-1 rounded text-2xs bg-surface-3 hover:bg-surface-4 text-body transition-colors shrink-0 disabled:opacity-40 disabled:cursor-default"
          >
            Add
          </button>
        </div>
        {err && <p className="text-3xs text-red-300">{err}</p>}
      </div>
    </section>
  );
}
