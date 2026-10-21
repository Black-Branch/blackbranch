"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useBadges, badgesForMatrixId, type BadgeDef } from "@/app/lib/BadgesContext";
import { StyledName } from "@/app/components/profileCardParts";
import { localpart } from "@/app/lib/matrixDisplay";
import { readProfileCard } from "@/app/lib/profileCardPrefetch";
import { useLocalStorageString } from "@/app/lib/useClientState";
import {
  // The tiles render through StyledName — a second caller of the style
  // generator would be a second thing to keep in step with chat.
  USERNAME_STYLES, previewStyleSet, STYLE_GROUPS, forSale,
  type EquippedStyle, type StyleCategory,
} from "@/app/lib/usernameStyles";
import { currencyName, currencyTitle } from "@/app/lib/currency";
import { useStorePrices, refreshStorePrices } from "@/app/lib/useStorePrices";
import type { PriceChange } from "@/app/lib/storePricing";
import { setCoinBalance } from "@/app/lib/useCoinBalance";
import { postJson, getJson } from "@/app/lib/http";
import { storeSpendFailureCopy } from "@/app/lib/spendFailureCopy";
import { DEFAULT_NAME_COLOR } from "@/app/lib/colors";
import EmptyState from "@/app/components/EmptyState";

// The store's Spend tab: every coin sink in one place. Tiles grey out with a
// reason instead of disappearing (a paid effect that can't run right now —
// TTS gate off, no sound clips — should be visibly "not yet", never a charge
// that gets silently refunded).

/**
 * How far a style tile is allowed to paint outside its own column, in px.
 *
 * A style tile cannot use `overflow: hidden` — that clips the halos and the
 * wobble, which is the only thing distinguishing glow/pulse/emboss from a plain
 * name. But left unbounded, a name wider than its column paints straight over
 * the tiles beside it. `overflow-x: clip` plus this margin is
 * the middle: everything the style actually draws still lands, and a name that
 * does not fit is cut here rather than at the far edge of the grid.
 *
 * MEASURED, NOT EYEBALLED. It is the widest halo an EFFECT can emit, plus 1:
 *   • glow's outer bloom — `0 0 13px` (usernameStyles.ts) — the largest
 *   • un-pulse's 50% keyframe — `0 0 12px` (globals.css)
 * `storeStylePreview.test.ts` re-derives that maximum from those two files and
 * fails if either grows past this, so a future effect with a bigger halo cannot
 * quietly start being clipped instead.
 *
 * `--chat-shadow` is deliberately NOT covered, and that is a trade rather
 * than an oversight. Its wide layer follows the user's blur slider — 12px at
 * the default, up to 36px at maximum (`shadowSpec`, settingsRegistry.ts) — so
 * no fixed margin can contain it. It is also the one layer whose clipping costs
 * nothing here: it is the same soft black lift under EVERY style, so cutting it
 * at the tile edge removes no information about which style you are looking at.
 * The effect halos are the whole point, and they are fixed, so they are what
 * this number is sized to.
 */
const HALO_CLIP_MARGIN = 14;

// A tile previews the name ALONE. The badges do not change with the style, and
// squeezed in beside a long name they push it under the smallest readable zoom
// and cut it off. The preview row above keeps them.
const NO_BADGES: BadgeDef[] = [];

// One spend POST: client-generated idempotency key, fresh-balance propagation,
// readable error string back to the caller's section.
async function spend(url: string, body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await postJson(url, { ...body, spendId: crypto.randomUUID() });
    const d = (await res.json().catch(() => ({}))) as { balance?: number; error?: string; retryAfterSeconds?: number; price?: number };
    if (res.ok) {
      if (typeof d.balance === "number") setCoinBalance(d.balance);
      return null;
    }
    // The stale price is what CAUSED a price_changed 409 — refresh the table
    // so the tiles re-render with the number the server will accept, instead
    // of looping the same expectedPrice forever (the sticker flow's 409
    // handling is the model).
    if (d.error === "price_changed") refreshStorePrices();
    // The copy decision is pure and tested (spendFailureCopy.test.ts) — a 4xx
    // refusal may say "nothing was charged", an unclassifiable 5xx never may.
    return storeSpendFailureCopy(res.status, d);
  } catch {
    return "Network error.";
  }
}

const sect = "rounded-xl border border-raised bg-panel/60 p-3 flex flex-col gap-2";
const h = "text-xs font-semibold uppercase tracking-wide text-secondary";
const buyBtn =
  "rounded px-2 py-1 text-2xs font-semibold bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25 transition-colors disabled:opacity-40";

export default function StoreSpend() {
  const badges = useBadges();
  const me = badges.myMatrixId;
  const my = me ? badges.perUser[me] : undefined;
  const unlockedSet = useMemo(() => new Set(my?.unlocked ?? []), [my]);
  // The style tiles preview on the buyer's OWN name and badges. Both are
  // already in context — this adds no request.
  const myBadges = useMemo(() => (me ? badgesForMatrixId(badges, me) : []), [badges, me]);
  // Display name from the profile-card cache when the user has opened their
  // card this session; the localpart otherwise. Deliberately no fetch — a
  // preview is not worth a request, and the localpart is still THEIR name at
  // the right size, which is what matters.
  const myName = (me && readProfileCard(me)?.me?.displayName) || (me ? localpart(me) : "your name");

  // Live prices. Each tile shows "—" and stays disabled until the table lands
  // — never a constant, because the number shown is the number sent as
  // expectedPrice and the server refuses any disagreement.
  const { prices, e: earnRate } = useStorePrices();
  const slotPrice = prices?.badge_slot ?? null;

  const [styleState, setStyleState] = useState<{ style: EquippedStyle | null; unlocked: string[] } | null>(null);
  // Admin price overrides (site.style_prices, migrate-v69) — merged over the
  // catalog defaults; the spend route reads the same table.
  const [stylePrices, setStylePrices] = useState<Record<string, number>>({});
  const [err, setErr] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // Own name color (same localStorage store chat uses) — previews style items
  // the way they'd actually look on THIS user's name.
  const [myColor] = useLocalStorageString("chatUsernameColor");
  // The style the full-width preview row is showing. null = show what the
  // user already wears, so the row is never empty and never lies about the
  // default. Set by pointer, by focus, and by the tap that arms a purchase —
  // that last one is the whole touch story, since a phone has no hover.
  const [previewStyle, setPreviewStyle] = useState<EquippedStyle | null>(null);

  // Equip/clear one category ({ gradient: "fade" } / { gradient: null }).
  async function equipStyle(cat: StyleCategory, id: string | null) {
    const r = await postJson("/api/me/style", { [cat]: id }, "PATCH").catch(() => null);
    if (r?.ok) {
      const d = (await r.json().catch(() => null)) as { style?: EquippedStyle | null } | null;
      setStyleState((p) => (p ? { ...p, style: d?.style ?? null } : p));
      setErr((prev) => ({ ...prev, equip: null }));
    } else {
      setErr((prev) => ({ ...prev, equip: "Couldn’t change your style — try again." }));
    }
  }

  useEffect(() => {
    getJson<{ style: EquippedStyle | null; unlocked: string[] }>("/api/me/style")
      .then((d) => setStyleState(d)).catch(() => {});
    getJson<{ prices?: Record<string, number> }>("/api/styles/prices")
      .then((d) => d.prices && setStylePrices(d.prices)).catch(() => {});
  }, []);

  // Admin: set E — the points a median engaged viewer earns per stream. Every
  // store price is stored as a NUMBER OF STREAMS and rendered against E, so
  // this one number moves the whole table at once.
  //
  // Two steps, always. The first POST is a DRY RUN that writes nothing and
  // returns exactly what would move; only after the admin reads that list and
  // confirms does the second POST apply it. This is not ceremony: damping caps
  // each run at ±10%, so the number typed here is NOT the number the store
  // lands on, and the rounding ladder means some items will not move at all.
  // Seeing the real moves first is the difference between a considered change
  // and a surprise repricing.
  async function editEarnRate() {
    const raw = window.prompt(
      `${currencyTitle()} a typical viewer earns per stream. Every price is stored as a number of ` +
      `STREAMS and rendered against this, so changing it moves the whole store.\n\n` +
      `Prices move by at most 10% per change, so a big jump takes several.`,
      earnRate === null ? "" : String(earnRate)
    );
    if (raw === null) return;
    const next = Math.round(Number(raw));
    if (!Number.isFinite(next) || next <= 0) return;

    setBusy("earnRate");
    try {
      const preview = await postJson("/api/store/prices/recompute", { e: next });
      const pd = (await preview.json().catch(() => ({}))) as
        { changes?: PriceChange[]; current?: number; error?: string };
      if (!preview.ok) {
        setErr((prev) => ({ ...prev, earnRate: pd.error === "bad_e" ? "That is outside the allowed range (5–500)." : "Could not read the change." }));
        return;
      }
      const changes = pd.changes ?? [];
      const ok = window.confirm(
        changes.length === 0
          ? `Earn rate ${pd.current ?? "?"} → ${next}\n\n` +
            `No price would move — the rounding steps absorb a change this small.\n\n` +
            `Record the new earn rate anyway?`
          : `Earn rate ${pd.current ?? "?"} → ${next}\n\n` +
            changes.map((c) => `  ${c.itemKey}: ${c.from} → ${c.to}`).join("\n") +
            `\n\nApply these ${changes.length} price change(s)?`
      );
      if (!ok) return;

      const res = await postJson("/api/store/prices/recompute", { e: next, apply: true });
      if (!res.ok) {
        setErr((prev) => ({ ...prev, earnRate: "The change was not applied." }));
        return;
      }
      // Everyone holding the old prices gets 409 price_changed on their next
      // spend; pulling the new table here at least makes THIS client correct.
      refreshStorePrices();
      setErr((prev) => ({ ...prev, earnRate: null }));
    } finally {
      setBusy(null);
    }
  }

  // Admin: reprice a badge from the store itself (same PATCH as BadgesSection's
  // $ control) — works on owned/equipped badges too; empty/0 takes it off sale.
  async function editBadgePrice(id: number, current: number | null) {
    const raw = window.prompt(
      `Store price in ${currencyName()} (1 = 1¢). Empty or 0 removes it from the store.`,
      current ? String(current) : ""
    );
    if (raw === null) return;
    const n = Math.round(Number(raw));
    const coinPrice = raw.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
    const r = await postJson(`/api/badges?id=${id}`, { coinPrice }, "PATCH").catch(() => null);
    if (r?.ok) badges.refresh();
  }

  // Admin: reprice a style (prompt-driven, mirrors BadgesSection's $ control).
  // Empty resets to the catalog default; styles are never delisted.
  async function editStylePrice(id: string, current: number, fallback: number) {
    const raw = window.prompt(
      `Price in ${currencyName()} (1 = 1¢). Empty resets to the default (${fallback}).`,
      String(current)
    );
    if (raw === null) return;
    const n = Math.round(Number(raw));
    const price = raw.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
    const r = await postJson("/api/styles/prices", { styleId: id, price }, "PATCH").catch(() => null);
    if (r?.ok) {
      setStylePrices((p) => {
        const next = { ...p };
        if (price === null) delete next[id];
        else next[id] = price;
        return next;
      });
    }
  }

  async function run(section: string, url: string, body: Record<string, unknown>, after?: () => void) {
    setBusy(section);
    const e = await spend(url, body);
    setErr((prev) => ({ ...prev, [section]: e }));
    setBusy(null);
    if (!e) after?.();
  }

  // Misclick guard on every sink: first click ARMS the button (label flips to
  // "Confirm <price>?"), the second click within ~3s actually spends. Arming
  // one button disarms any other. Inline two-step state, not window.confirm —
  // same pattern as MsgContextMenu's delete confirm.
  const [armed, setArmed] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (disarmTimer.current) clearTimeout(disarmTimer.current); }, []);

  function confirmRun(section: string, url: string, body: Record<string, unknown>, after?: () => void) {
    if (armed !== section) {
      setArmed(section);
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(() => setArmed(null), 3000);
      return;
    }
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    setArmed(null);
    void run(section, url, body, after);
  }

  // Armed buttons brighten so the state change is visible beyond the label.
  const armCls = (section: string) =>
    armed === section ? " bg-yellow-500/30 text-yellow-200" : "";

  // Admins see every priceable badge (unpriced ones included, so anything can
  // be put on sale right from the store); everyone else sees what's on sale.
  const sellableBadges = badges.catalog.filter(
    (b) => (badges.isAdmin || b.coinPrice != null) && !b.isSubscriber && !b.isMod
  );

  return (
    <div className="flex flex-col gap-3">
      {/* The two-tap confirm only changes a BUTTON's label ("Confirm 250?") —
          screen readers don't reliably re-announce a label change on a control
          that already has focus, so the armed state would be silent for them.
          One hidden status line announces it; polite, so it
          doesn't stomp the error alerts. */}
      <span role="status" className="sr-only">
        {armed ? "Tap again to confirm this purchase." : ""}
      </span>
      {/* Cheering is not a store ITEM: highlight and read-aloud are fixed-price
          products armed from the composer's +. COIN_KINDS / KIND_POLICY
          (stream-api/money.js) still carry `cheer`: money.js throws at module
          load if the two sets disagree, and the entry stays load-bearing for
          historical support_events folds (money-policy.test.js's "cheer stays
          in COIN_KINDS even though nothing can buy one"). Do NOT remove it.
          Historical site.coin_ledger rows with sink='cheer' are untouched —
          nothing deletes ledger history. */}

      {/* Admin: the one number every price is derived from. */}
      {badges.isAdmin && (
        <section className={sect}>
          <span className={h}>Earn rate (admin)</span>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-xs text-body">
              {earnRate === null ? "—" : `${earnRate} ${currencyName(earnRate)} per stream`}
              <span className="block text-2xs text-muted">
                Every price is stored as a number of streams and rendered against this.
              </span>
            </span>
            <button
              className={buyBtn}
              disabled={busy === "earnRate" || earnRate === null}
              onClick={editEarnRate}
            >
              {busy === "earnRate" ? "Checking…" : "Adjust"}
            </button>
          </div>
          {err.earnRate && <p role="alert" className="text-xs text-red-400">{err.earnRate}</p>}
        </section>
      )}

      {/* Badges */}
      <section className={sect}>
        <span className={h}>Badges</span>
        {sellableBadges.length === 0 ? (
          <EmptyState>Nothing on sale yet.</EmptyState>
        ) : (
          // Scrolls rather than grows, so the catalog does not take up more
          // space as styles are added.
          <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto overscroll-contain">
            {sellableBadges.map((b) => {
              const owned = unlockedSet.has(b.id);
              return (
                <div key={b.id} className="flex items-center gap-2 rounded-lg bg-surface-1 px-2 py-1.5">
                  <img src={b.imageUrl} alt="" className="h-5 w-5 shrink-0 rounded" />
                  <span className="min-w-0 flex-1 truncate text-xs text-body">{b.name}</span>
                  {owned ? (
                    <span className="text-2xs text-emerald-400">Owned</span>
                  ) : b.coinPrice != null ? (
                    <button
                      className={buyBtn + armCls(`badge-${b.id}`)}
                      disabled={busy === `badge-${b.id}`}
                      onClick={() =>
                        // expectedPrice = the number on THIS button — the route's
                        // priceGuard refuses if an admin repriced it mid-confirm.
                        confirmRun(`badge-${b.id}`, "/api/badges/buy", { badgeId: b.id, expectedPrice: b.coinPrice }, badges.refresh)}
                    >
                      {armed === `badge-${b.id}` ? `Confirm ${b.coinPrice.toLocaleString()}?` : b.coinPrice.toLocaleString()}
                    </button>
                  ) : (
                    <span className="text-2xs text-muted">Not on sale</span>
                  )}
                  {badges.isAdmin && (
                    <button
                      className={`shrink-0 text-3xs ${b.coinPrice != null ? "text-yellow-500/80" : "text-muted"} hover:text-yellow-300`}
                      title="Set the store price (admin)"
                      onClick={() => editBadgePrice(b.id, b.coinPrice ?? null)}
                    >
                      ✎
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {sellableBadges.some((b) => err[`badge-${b.id}`]) && (
          <p role="alert" className="text-xs text-red-400">
            {sellableBadges.map((b) => err[`badge-${b.id}`]).find(Boolean)}
          </p>
        )}
        <div className="flex items-center justify-between border-t border-edge pt-2">
          <span className="text-xs text-body-dim">
            Extra badge slot <span className="text-muted">(equip in your profile)</span>
          </span>
          <button
            className={buyBtn + armCls("slot")}
            disabled={busy === "slot" || slotPrice === null}
            onClick={() => confirmRun("slot", "/api/badges/buy-slot", { expectedPrice: slotPrice }, badges.refresh)}
          >
            {slotPrice === null ? "\u2014"
              : armed === "slot" ? `Confirm ${slotPrice.toLocaleString()}?`
              : slotPrice.toLocaleString()}
          </button>
        </div>
        {err.slot && <p role="alert" className="text-xs text-red-400">{err.slot}</p>}
      </section>

      {/* Name styles — three combinable categories, previewed on YOUR color. */}
      <section className={sect}>
        <span className={h}>Name styles</span>
        {/* ── The preview row ──────────────────────────────────────────────────
            One full-width, un-clipped rendering of the style you are pointing
            at. It exists because the grid below CANNOT show a long name at full
            fidelity: the tiles are a hard split of a narrow panel, and a name
            that does not fit its column would paint over its neighbours.
            Clipping the tiles is not available on its own — see the note on the
            tile span — so the fidelity lives somewhere with room instead. The
            row is the preview; the tiles are the index.
            ZOOM, never stretch — and here that is literal. `zoom` scales the
            LAYOUT box as well as the paint (transform: scale() would not), and it
            keeps the proportions the styles depend on (halo radius, stroke
            weight, the wobble's rotation centre), which a larger font-size would
            not. The zoom is FITTED (StyledName `fit`): up to
            1.35× for a short name, shrunk for a long one. Scrolling instead
            would clip the tall faces top and bottom (overflow-x forces
            overflow-y). */}
        <div className="flex min-h-14 items-center justify-center-safe rounded-lg bg-surface-1 px-3 py-2">
          <StyledName
            name={myName}
            color={myColor ?? DEFAULT_NAME_COLOR}
            style={previewStyle ?? styleState?.style ?? null}
            badges={myBadges}
            fit={1.35}
            replay
          />
        </div>
        {/* Order and headings come from STYLE_GROUPS, shared with the profile
            editor — a viewer meets these styles in both places, and a category
            called "Effects" here and something else there reads as two
            different catalogues. */}
        {STYLE_GROUPS.map(({ category: cat, label }) => (
          <div key={cat} className="flex flex-col gap-1">
            <span className="text-3xs uppercase tracking-wide text-muted">{label}</span>
            {/* Scrolls rather than grows. The padding is room for
                the halos and tall faces the scroll box would otherwise clip.
                Two across, not three: a third of this panel is ~85px, too
                narrow for a long name at a readable size. */}
            <div className="grid grid-cols-2 gap-1.5 max-h-64 overflow-y-auto overscroll-contain p-1 -m-1">
              {USERNAME_STYLES.filter((s) => s.category === cat && (forSale(s) || !!styleState?.unlocked.includes(s.id))).map((s) => {
                const owned = !!styleState?.unlocked.includes(s.id);
                const equipped = styleState?.style?.[cat] === s.id;
                const price = stylePrices[s.id] ?? s.price;
                // Previewed ON TOP of what the buyer already wears — an effect
                // shown against the default face is not a preview of anything
                // they can actually have, and it rendered visibly larger than
                // the font tiles because a bare effect carries no `scale`.
                const eq = previewStyleSet(styleState?.style, s);
                return (
                  <div
                    key={s.id}
                    className="flex flex-col items-stretch gap-1 rounded-lg bg-surface-1 px-2 py-1.5"
                    // Point at a tile and the row above renders it in full.
                    // Pointer AND focus, so the keyboard path previews too.
                    //
                    // Only a MOUSE clears on leave. A touch pointer fires
                    // enter and leave around a single tap, so clearing on
                    // `pointerleave` unconditionally would make the row flash
                    // the style and drop it again — the preview would be
                    // unreachable on a phone, which is where this panel is
                    // mostly read. On touch the last tapped tile simply stays
                    // previewed until another is tapped.
                    onPointerEnter={() => setPreviewStyle(eq)}
                    onFocus={() => setPreviewStyle(eq)}
                    onPointerLeave={(e) => { if (e.pointerType === "mouse") setPreviewStyle(null); }}
                    onBlur={() => setPreviewStyle(null)}
                  >
                    {/* Previewed on YOUR name at YOUR chat size
                        and username font, with the badges that will sit beside
                        it, so you know you want the item before buying — the
                        label moves to a caption below, because a style
                        rendered on the word "Blackletter" tells you what that
                        WORD looks like, not what your name will.

                        No `truncate`. Its `overflow: hidden` clips the
                        text-shadow halos (glow/pulse) and the wobble rotation,
                        which is what makes those three styles look identical to
                        a plain name.
                        `overflow-x: clip` with an `overflow-clip-margin` is the
                        version that satisfies both: the halo is still painted,
                        out to the margin, and a name too long for its column is
                        cut at the margin instead of running the width of the
                        grid. See HALO_CLIP_MARGIN for where that number comes
                        from — it is measured off the styles, not eyeballed, and
                        a test re-measures it.
                        Vertical stays visible: clip on one axis permits visible
                        on the other (unlike `hidden`, which forces auto).
                        A long name is SHRUNK to fit its tile (StyledName `fit`)
                        rather than cut at both ends; the clip is only the
                        backstop. */}
                    <span
                      className="whitespace-nowrap px-1 pb-1.5 flex justify-center-safe overflow-x-clip overflow-y-visible"
                      style={{ overflowClipMargin: `${HALO_CLIP_MARGIN}px` }}
                    >
                      <StyledName
                        name={myName}
                        color={myColor ?? DEFAULT_NAME_COLOR}
                        style={eq}
                        badges={NO_BADGES}
                        fit={1}
                        replay={cat === "entrance"}
                      />
                    </span>
                    <span className="text-3xs text-center text-muted leading-none">{s.label}</span>
                    {equipped ? (
                      <button
                        className="text-2xs text-emerald-400 hover:text-emerald-300"
                        onClick={() => equipStyle(cat, null)}
                      >
                        Equipped ✓
                      </button>
                    ) : owned ? (
                      <button className="text-2xs text-body-dim hover:text-strong" onClick={() => equipStyle(cat, s.id)}>
                        Equip
                      </button>
                    ) : (
                      <button
                        className={buyBtn + armCls(`style-${s.id}`)}
                        disabled={busy === `style-${s.id}`}
                        onClick={() =>
                          // expectedPrice = the number on THIS button (see badges above).
                          confirmRun(`style-${s.id}`, "/api/points/spend/style", { styleId: s.id, expectedPrice: price }, () =>
                            setStyleState((p) => (p ? { ...p, unlocked: [...p.unlocked, s.id] } : p)))}
                      >
                        {armed === `style-${s.id}` ? `Confirm ${price.toLocaleString()}?` : price.toLocaleString()}
                      </button>
                    )}
                    {badges.isAdmin && (
                      <button
                        className={`text-3xs ${stylePrices[s.id] != null ? "text-yellow-500/80" : "text-muted"} hover:text-yellow-300`}
                        title="Set the store price (admin)"
                        onClick={() => editStylePrice(s.id, price, s.price)}
                      >
                        {price.toLocaleString()} ✎
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {err.equip && <p role="alert" className="text-xs text-red-400">{err.equip}</p>}
        {USERNAME_STYLES.some((s) => err[`style-${s.id}`]) && (
          <p role="alert" className="text-xs text-red-400">{USERNAME_STYLES.map((s) => err[`style-${s.id}`]).find(Boolean)}</p>
        )}
        <p className="text-2xs text-muted">
          Effects follow your name color, and Custom gradient blends it into a second color
          you pick — both live in Edit profile.
        </p>
      </section>

      {/* Voice messages and the soundboard are not store items.
            · Read aloud is a fixed 150-point product armed from the composer's
              tools menu / `/tts`, not a store item, so it has no entry here.
              site.store_prices carries its `tts` row, and stream-api's
              `tts_msg` sink speaks its message — `tts_msg` is live and
              load-bearing.
            · The soundboard is PARKED, not dead: /api/points/spend/sound and
              the /api/points/sinks clip manifest are live (API-reachable, no UI
              entry) and meant to return under the composer's "message tools".
              Do not delete those — and stream-api's KIND_POLICY still carries
              `sound` and `tts_msg` and refuses to boot if COIN_KINDS
              disagree. */}
    </div>
  );
}
