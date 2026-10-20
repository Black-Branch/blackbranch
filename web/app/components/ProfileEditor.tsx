"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { localpart } from "@/app/lib/matrixDisplay";
import { dispatchClaimable } from "@/app/lib/claimableEvent";
import { postJson, getJson } from "@/app/lib/http";
import { mxcToScaled, onScaledError } from "@/app/lib/matrixMedia";
import { lsGet } from "@/app/lib/safeLocalStorage";
import { setOwnColor } from "@/app/lib/ownColor";
import { useClientValue } from "@/app/lib/useClientState";
import BadgeSlots from "./BadgeSlots";
import {
  USERNAME_STYLES, usernameStyleCSS, usernameStyleAnimClass,
  previewStyleSet, STYLE_GROUPS,
  type EquippedStyle, type StyleCategory,
} from "@/app/lib/usernameStyles";
import { currencyTitle } from "@/app/lib/currency";
import { DEFAULT_NAME_COLOR } from "@/app/lib/colors";
import { invalidateProfileCard, readProfileCard } from "@/app/lib/profileCardPrefetch";
import { StyledName } from "./profileCardParts";
import { useNameInk, useEntranceReplay } from "@/app/lib/nameInk";
import { useAnimFenceRef } from "@/app/lib/animFence";
import { useBadges, badgesForMatrixId } from "@/app/lib/BadgesContext";
import { CHAT_FONT } from "@/app/lib/chatFont";

// Profile editor — avatar, display name, username color, pronouns. Shared by
// the chat avatar menu and the Matrix-rail settings modal, so both render the
// same editor.
//
// Every JSON-field save here must end in invalidateProfileCard() — the
// profile card renders from a 15s-fresh cached batch, and a save that skips
// invalidation shows the PRE-edit value on the next open within that window.
// Route saves through saveProfileField below so the invalidation can't be
// forgotten. The two exceptions are IMAGE paths, which aren't in that batch:
// the banner (host's patch) and the avatar (onAvatarChanged + avatarVer
// cache-bust).

function isValidHex(s: string) {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// Pair a profile-field save with the cache invalidation the invariant above
// demands — a save site that goes through this can't forget it. Returns the
// route's Response (null on network error) so callers keep their own ok/error
// handling; the cache is only invalidated on an OK save (a failed one left it
// accurate).
async function saveProfileField(
  url: string,
  body: unknown,
  method: "PATCH" | "DELETE" = "PATCH",
): Promise<Response | null> {
  const r = await postJson(url, body, method).catch(() => null);
  if (r?.ok) invalidateProfileCard();
  return r;
}

function formatCooldown(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${mins}m`;
}


/** One owned-style tile's preview: the user's own name wearing the set, at chat
 *  size, captioned with the style's label. Its own component so the name
 *  can be measured for its side room (nameInk.ts) — a hook cannot run
 *  inside the tiles' map. */
function TileName({ style, color, name, label, replay }: { style: EquippedStyle; color: string; name: string; label: string; replay: boolean }) {
  const inkRef = useNameInk(style.font, name);
  const replayRef = useEntranceReplay(replay && !!style.entrance);
  const inkAndReplayRef = useCallback((el: HTMLSpanElement | null) => { inkRef(el); replayRef.current = el; }, [inkRef, replayRef]);
  // A tile scrolled out of the picker pauses; on screen it looks exactly the same.
  const nameRef = useAnimFenceRef(usernameStyleAnimClass(style) !== "", inkAndReplayRef);
  return (
    <span className="flex flex-col items-center gap-1.5">
      <span
        ref={nameRef}
        className={usernameStyleAnimClass(style)}
        style={{
          color,
          fontSize: CHAT_FONT,
          fontFamily: "var(--chat-username-font, inherit)",
          fontWeight: "var(--chat-username-weight, 600)" as React.CSSProperties["fontWeight"],
          textShadow: "var(--chat-shadow)",
          ...usernameStyleCSS(style, color),
        }}
      >
        {name}
      </span>
      <span className="text-3xs text-muted leading-none">{label}</span>
    </span>
  );
}

export default function ProfileEditor({
  matrixId,
  onBack,
  onAvatarChanged,
  onBannerChanged,
}: {
  matrixId: string;
  onBack: () => void;
  onAvatarChanged: () => void;
  /** Fired with the new mxc (or null on remove) so the host card re-renders its
   *  banner in place. */
  onBannerChanged?: (mxc: string | null) => void;
}) {
  // Warm profile cache: the hosting card just painted from it, so the name and
  // banner below initialize straight off the cached /api/me summary (read once
  // at mount — kills the editor's own pop-in). Seed only: the fetch below still
  // applies its fresh response in full when it lands, because readProfileCard
  // has no freshness bound — a rename on another device must not stick stale
  // here (and a stale currentName would burn the 7-day cooldown on a "no-op"
  // re-type of the real server name).
  const [cachedMe] = useState(() => readProfileCard(matrixId)?.me ?? null);
  const cachedName = cachedMe ? cachedMe.displayName ?? localpart(matrixId) : "";
  // The previews below show the badges that will really sit beside the
  // name. Already in context (BadgesProvider is in the root layout) — no fetch.
  const badgeState = useBadges();
  const [nameInput, setNameInput] = useState(cachedName);
  const [currentName, setCurrentName] = useState(cachedName);
  const [cooldownMsLeft, setCooldownMsLeft] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirmPending, setConfirmPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [avatarVer, setAvatarVer] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  // Banner (site.users.banner_mxc, v80). Cache-seeded / loaded with /api/me.
  const [bannerMxc, setBannerMxc] = useState<string | null>(cachedMe?.bannerMxc ?? null);
  const [bannerBusy, setBannerBusy] = useState(false);
  const [bannerErr, setBannerErr] = useState("");
  const bannerRef = useRef<HTMLInputElement>(null);
  const [color, setColor] = useState(DEFAULT_NAME_COLOR);
  const [colorInput, setColorInput] = useState(DEFAULT_NAME_COLOR);
  const [colorSaving, setColorSaving] = useState(false);
  const [pronouns, setPronouns] = useState<string | null>(null);
  const [pronounsSaving, setPronounsSaving] = useState(false);
  // Bio — one line, ≤ 200 chars (site.users.bio, v126). Seeded from the warm
  // card cache like the name; saved on blur through the same helper.
  const [bio, setBio] = useState(() => readProfileCard(matrixId)?.me?.bio ?? "");
  const [bioSaving, setBioSaving] = useState(false);
  // What the server last confirmed: a blur with nothing changed saves nothing
  // (the field seeded empty from a cleared cache once ERASED a saved bio on
  // blur — final review, Important 4).
  const savedBio = useRef(bio);
  const saveBio = useCallback(async () => {
    if (bio === savedBio.current) return;
    setBioSaving(true);
    const r = await saveProfileField("/api/me/bio", { bio });
    const d = r ? ((await r.json().catch(() => null)) as { bio?: string } | null) : null;
    if (typeof d?.bio === "string") { setBio(d.bio); savedBio.current = d.bio; }
    setBioSaving(false);
  }, [bio]);
  // Qorm-store name styles: equipped set + owned ids (see usernameStyles.ts).
  const [styleSet, setStyleSet] = useState<{ style: EquippedStyle | null; unlocked: string[] } | null>(null);

  useEffect(() => {
    getJson<{ style: EquippedStyle | null; unlocked: string[] }>("/api/me/style")
      .then(d => setStyleSet(d))
      .catch(() => {});
  }, []);

  const equipStyle = useCallback(async (cat: StyleCategory, id: string | null) => {
    const r = await saveProfileField("/api/me/style", { [cat]: id });
    if (r?.ok) {
      const d = (await r.json().catch(() => null)) as { style?: EquippedStyle | null } | null;
      setStyleSet(p => (p ? { ...p, style: d?.style ?? null } : p));
    }
  }, []);

  // Second stop of the "duo" gradient — local echo immediately, debounced PATCH
  // (the native color input fires continuously while dragging).
  const gradColorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyGradientColor = useCallback((hex: string) => {
    if (!isValidHex(hex)) return;
    setStyleSet(p => (p ? { ...p, style: { ...(p.style ?? {}), gradientColor: hex } } : p));
    if (gradColorTimer.current) clearTimeout(gradColorTimer.current);
    gradColorTimer.current = setTimeout(() => {
      void saveProfileField("/api/me/style", { gradientColor: hex });
    }, 400);
  }, []);

  useEffect(() => {
    getJson<{ displayName?: string | null; displayNameChangedAt?: string | null; bannerMxc?: string | null; bio?: string | null }>("/api/me").then(d => {
      const name = d.displayName ?? localpart(matrixId);
      setNameInput(name);
      setCurrentName(name);
      setBannerMxc(d.bannerMxc ?? null);
      setBio(d.bio ?? "");
      savedBio.current = d.bio ?? "";
      if (d.displayNameChangedAt) {
        const ms = COOLDOWN_MS - (Date.now() - new Date(d.displayNameChangedAt).getTime());
        setCooldownMsLeft(Math.max(0, ms));
      }
    }).catch(() => {});
  }, [matrixId]);

  // One-shot restore of the saved color on the first client render (the store
  // value is null during SSR) — render-time adjust, no effect pass.
  const savedColor = useClientValue(() => lsGet("chatUsernameColor"), null);
  const [colorRestored, setColorRestored] = useState(false);
  if (!colorRestored && savedColor !== null) {
    setColorRestored(true);
    if (isValidHex(savedColor)) { setColor(savedColor); setColorInput(savedColor); }
  }

  useEffect(() => {
    getJson<{ pronouns?: string | null }>("/api/me/pronouns")
      .then(d => setPronouns(d.pronouns ?? null))
      .catch(() => {});
  }, []);

  const applyPronouns = useCallback(async (value: string | null) => {
    setPronouns(value);
    setPronounsSaving(true);
    if (value) await saveProfileField("/api/me/pronouns", { pronouns: value });
    else await saveProfileField("/api/me/pronouns", undefined, "DELETE");
    setPronounsSaving(false);
  }, []);

  const applyColor = useCallback((hex: string) => {
    if (!isValidHex(hex)) return;
    setColor(hex);
    setColorInput(hex);
    // One path with the terminal's profile file: on the page now,
    // saved coalesced (ownColor.ts) — a save still waiting lands even after the editor closes.
    setColorSaving(true);
    void setOwnColor(hex).then(() => setColorSaving(false));
  }, []);

  // NOTE: the gradient colour's debounce timer is deliberately NOT cleared on unmount —
  // closing the editor inside the debounce window must still land the pending
  // save (the timer body is the PATCH). The late setState is a React no-op.
  const uploadAvatar = useCallback(async (file: File) => {
    setUploading(true);
    const form = new FormData();
    form.append("avatar", file);
    // Raw fetch on purpose: multipart body — postJson is JSON-only.
    await fetch("/api/avatar/upload", { method: "POST", body: form }).catch(() => {});
    setAvatarVer(v => v + 1);
    setUploading(false);
    onAvatarChanged();
  }, [onAvatarChanged]);

  const uploadBanner = useCallback(async (file: File) => {
    setBannerBusy(true);
    setBannerErr("");
    const form = new FormData();
    form.append("banner", file);
    // Raw fetch on purpose: multipart body — postJson is JSON-only.
    const res = await fetch("/api/banner/upload", { method: "POST", body: form }).catch(() => null);
    if (res?.ok) {
      const d = (await res.json().catch(() => null)) as { banner_mxc?: string } | null;
      const mxc = d?.banner_mxc ?? null;
      setBannerMxc(mxc);
      onBannerChanged?.(mxc);
    } else {
      // Surface the route's short plaintext reason (size/type/cooldown).
      const t = res ? await res.text().catch(() => "") : "";
      setBannerErr(t && t.length < 80 ? t : "Upload failed. Please try again.");
    }
    setBannerBusy(false);
  }, [onBannerChanged]);

  const removeBanner = useCallback(async () => {
    setBannerBusy(true);
    setBannerErr("");
    const res = await postJson("/api/banner/upload", undefined, "DELETE").catch(() => null);
    if (res?.ok) {
      setBannerMxc(null);
      onBannerChanged?.(null);
    } else {
      setBannerErr("Remove failed. Please try again.");
    }
    setBannerBusy(false);
  }, [onBannerChanged]);

  async function saveName() {
    const trimmed = nameInput.trim();
    if (!trimmed || saving || cooldownMsLeft > 0) return;
    if (trimmed === currentName) { onBack(); return; }
    if (!confirmPending) { setConfirmPending(true); return; }
    setSaving(true);
    setSaveError("");
    const res = await saveProfileField("/api/me/displayname", { displayName: trimmed });
    setSaving(false);
    if (!res || !res.ok) {
      const data = await res?.json().catch(() => null);
      if (data?.error === "cooldown") {
        setCooldownMsLeft(data.msLeft ?? COOLDOWN_MS);
        setSaveError("Name change on cooldown — try again later.");
      } else {
        setSaveError("Save failed. Please try again.");
      }
      setConfirmPending(false);
      return;
    }
    setCurrentName(trimmed);
    setCooldownMsLeft(COOLDOWN_MS);
    setConfirmPending(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="p-3 space-y-3">
      <p className="text-3xs uppercase tracking-wider text-muted font-medium">Edit profile</p>

      {/* Banner — the strip behind the avatar on the profile card. */}
      <div>
        <label className="text-3xs text-muted uppercase tracking-wide mb-1.5 block">
          Banner{bannerBusy && <span className="ml-1 text-muted normal-case">working…</span>}
        </label>
        <button
          type="button"
          onClick={() => !bannerBusy && bannerRef.current?.click()}
          // h-20, matching CardBanner's own h-20 exactly, so the preview crops
          // the same way as the card it is previewing.
          className="relative group w-full h-20 rounded-lg overflow-hidden ring-1 ring-edge bg-surface-2"
        >
          {bannerMxc && (
            <img
              src={mxcToScaled(bannerMxc) ?? undefined}
              alt="banner"
              className="w-full h-full object-cover"
              onError={e => onScaledError(e.currentTarget, bannerMxc)}
            />
          )}
          {bannerMxc && (
            /* Crop preview. The card is RESIZABLE, so there is no single correct
               aspect ratio to promise — the narrowest surface is the public
               UserCard at w-72 (288 × 80 = 3.6:1), and object-cover centre-crops
               everything outside that. Showing what is LOST rather than drawing
               guide lines: a line has to out-contrast whatever image it lands on,
               a scrim reads on any of them.

               Three flex children rather than a measured width — the middle takes
               its width from the aspect ratio, the scrims split the remainder, and
               when the preview is narrower than 3.6:1 the middle shrinks and the
               scrims collapse to nothing on their own. No JS, correct at every
               width. */
            <div aria-hidden className="absolute inset-0 flex pointer-events-none">
              <div className="flex-1 bg-scrim" />
              <div className="h-full max-w-full" style={{ aspectRatio: "3.6 / 1" }} />
              <div className="flex-1 bg-scrim" />
            </div>
          )}
          <div className="absolute inset-0 bg-scrim-strong flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <span className="text-3xs text-strong font-medium">
              {bannerBusy ? "Working…" : bannerMxc ? "Change" : "Upload"}
            </span>
          </div>
        </button>
        <div className="flex items-center justify-between mt-1">
          <p className="text-3xs text-muted">
            Recommended 800×200 · max 6 MB
            {bannerMxc && <> · dimmed edges are cropped on narrow cards</>}
          </p>
          {bannerMxc && (
            <button
              type="button"
              onClick={removeBanner}
              disabled={bannerBusy}
              className="text-3xs text-muted hover:text-red-400 transition-colors disabled:opacity-40"
            >
              Remove
            </button>
          )}
        </div>
        {bannerErr && <p className="text-2xs text-red-400 mt-1">{bannerErr}</p>}
        <input
          ref={bannerRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) uploadBanner(f); e.target.value = ""; }}
        />
      </div>

      {/* Avatar + display name together: they are one thing — the pair a
          reader sees together on every chat row. */}
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => !uploading && fileRef.current?.click()}
            title="Click to change your avatar"
            className="relative group w-16 h-16 rounded-full overflow-hidden shrink-0 ring-1 ring-edge"
          >
            <img
              key={avatarVer}
              src={`/api/avatar/me?v=${avatarVer}`}
              alt="avatar"
              className="w-full h-full object-cover"
              onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            {/* The hover label is what makes it discoverable as a control — the
                caption below has no room for it beside a text field. */}
            <div className="absolute inset-0 bg-scrim-strong flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <span className="text-3xs text-strong font-medium">{uploading ? "Uploading…" : "Change"}</span>
            </div>
          </button>
          <p className="text-3xs text-muted">max 4 MB</p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) uploadAvatar(f); e.target.value = ""; }}
          />
        </div>
        <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <label className="text-3xs text-muted uppercase tracking-wide">Display name</label>
          <span className={`text-3xs tabular-nums ${nameInput.length >= 32 ? "text-red-400" : "text-muted"}`}>
            {nameInput.length}/32
          </span>
        </div>
        {cooldownMsLeft > 0 ? (
          <p className="text-2xs text-yellow-400/80 mb-1">
            Locked — {formatCooldown(cooldownMsLeft)} remaining
          </p>
        ) : null}
        <input
          type="text"
          value={nameInput}
          onChange={e => { setNameInput(e.target.value); setConfirmPending(false); setSaveError(""); }}
          onKeyDown={e => { if (e.key === "Enter") saveName(); }}
          maxLength={32}
          disabled={cooldownMsLeft > 0}
          placeholder="Your display name"
          className="w-full bg-surface-2 border border-edge text-sm text-strong rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-edge-strong disabled:opacity-40 disabled:cursor-not-allowed"
        />
        {confirmPending && (
          <p className="text-2xs text-amber-400/90 mt-1">
            Name locked for 7 days after saving. Confirm?
          </p>
        )}
        {saveError && (
          <p className="text-2xs text-red-400 mt-1">{saveError}</p>
        )}
        </div>
      </div>

      {/* Preview — ABOVE the colour and style pickers, because it is what every
          control below it changes. Below them, on a phone the pickers would
          push the one surface that answers "what will this look like" off
          screen exactly while you are using them.

          This is the CHAT renderer, at chat size, with the badges that will
          actually be beside the name — not "your name" at whatever size this
          panel happens to be. Reusing StyledName is the point; a second
          hand-rolled preview would drift. */}
      <div className="text-3xs text-muted">
        <span className="block mb-1">Preview:</span>
        <StyledName
          name={currentName || localpart(matrixId)}
          color={color}
          style={styleSet?.style ?? null}
          badges={badgesForMatrixId(badgeState, matrixId)}
          fit={1}
          replay
        />
      </div>

      {/* Username color */}
      <div>
        <label className="text-3xs text-muted uppercase tracking-wide mb-1.5 block">
          Username color{colorSaving && <span className="ml-1 text-muted">saving…</span>}
        </label>
        <div className="flex gap-2 items-center mb-1.5">
          <input type="color"
            value={isValidHex(colorInput) ? colorInput : DEFAULT_NAME_COLOR}
            onChange={e => applyColor(e.target.value)}
            className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 p-0"
          />
          <input type="text" value={colorInput}
            onChange={e => setColorInput(e.target.value)}
            onBlur={e => applyColor(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") applyColor(colorInput); }}
            maxLength={7} placeholder={DEFAULT_NAME_COLOR}
            className="flex-1 min-w-0 bg-surface-2 text-xs text-strong rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-edge-strong font-mono"
          />
          {/* The duo gradient's SECOND stop, beside the first: the two halves of
              one gradient are one choice and belong on one row. Rendered only
              when duo is equipped — it has nothing to mean otherwise. */}
          {styleSet?.style?.gradient === "duo" && (
            <input
              type="color"
              value={styleSet.style?.gradientColor ?? "#ffffff"}
              onChange={e => applyGradientColor(e.target.value)}
              className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 p-0 shrink-0"
              title="Second gradient colour — your name blends into this"
              aria-label="Second gradient colour"
            />
          )}
        </div>
      </div>

      {/* Name style — equip Qorm-store fonts/effects/gradients (they derive
          from the color above, so the preview follows the picker live). */}
      <div>
        <label className="text-3xs text-muted uppercase tracking-wide mb-1.5 block">Name style</label>
        {styleSet && styleSet.unlocked.length > 0 ? (
          /* Grouped by category. One flat wrap would put fonts, effects and
             gradients in one stream and hide the rule that matters: you may
             equip one of EACH, not one in total. The headings are the rule
             made visible. */
          <div className="space-y-2">
            {STYLE_GROUPS.map(({ category, label }) => {
              const owned = USERNAME_STYLES.filter(
                (s) => s.category === category && styleSet.unlocked.includes(s.id)
              );
              if (owned.length === 0) return null;
              return (
                <div key={category}>
                  <span className="text-3xs text-muted/70 block mb-1">{label}</span>
                  {/* Scrolls rather than grows, so the catalog does not take up
                      more space as styles are added. The padding is room for the
                      halos and tall faces the scroll box would otherwise clip. */}
                  <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto overscroll-contain p-1 -m-1">
                    {owned.map((s) => {
                      const equipped = styleSet.style?.[s.category] === s.id;
                      // What the name would ACTUALLY look like with this tile
                      // applied — the rest of the equipped set included.
                      const eq = previewStyleSet(styleSet.style, s);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => equipStyle(s.category, equipped ? null : s.id)}
                          title={equipped ? "Unequip" : `Equip (${s.category})`}
                          className={`px-2 py-1 text-2xs rounded border transition-colors ${
                            equipped
                              ? "bg-surface-3 border-edge-strong"
                              : "bg-surface-1 border-edge hover:bg-surface-2"
                          }`}
                        >
                          {/* Preview on the user's OWN name at chat size,
                              label kept as a caption underneath — the style
                              rendered on the word "Blackletter" tells you what
                              that word looks like, not what your name will. */}
                          <TileName style={eq} color={color} name={currentName || localpart(matrixId)} label={s.label} replay={s.category === "entrance"} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-3xs text-muted">You don’t own any styles yet.</p>
        )}
        <button
          type="button"
          // dispatchClaimable, not a bare CustomEvent: the hub's one-host
          // guard reads defaultPrevented — cancelable only (useUserMenuEvents.ts).
          onClick={() => { dispatchClaimable("bb:open-store", { tab: "spend" }); }}
          className="mt-1.5 text-2xs text-yellow-500/90 hover:text-yellow-400 transition-colors"
        >
          Get more in the {currencyTitle()} store →
        </button>
      </div>

      {/* Pronouns */}
      <div>
        <label className="text-3xs text-muted uppercase tracking-wide mb-1.5 block">
          Pronouns{pronounsSaving && <span className="ml-1 text-muted">saving…</span>}
        </label>
        <div className="flex gap-1.5">
          {([
            ["he/him", "he/him"],
            ["she/her", "she/her"],
            ["they/them", "they/them"],
            [null, "—"],
          ] as [string | null, string][]).map(([val, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => applyPronouns(val)}
              className={`flex-1 px-2 py-1.5 text-2xs rounded border transition-colors ${
                pronouns === val
                  ? "bg-surface-3 border-edge-strong text-strong"
                  : "bg-surface-1 border-edge text-secondary hover:text-strong hover:bg-surface-2"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Bio */}
      <div>
        <label className="text-3xs text-muted uppercase tracking-wide mb-1.5 block">
          About you{bioSaving && <span className="ml-1 text-muted">saving…</span>}
        </label>
        <input
          type="text"
          maxLength={200}
          value={bio}
          placeholder="One line, up to 200 characters"
          onChange={(e) => setBio(e.target.value)}
          onBlur={() => void saveBio()}
          className="w-full px-2 py-1.5 text-2xs rounded border border-edge bg-surface-1 text-strong placeholder:text-muted"
        />
      </div>

      {/* Badge slots — equip your unlocked badges into your unlocked slots */}
      <div>
        <label className="text-3xs text-muted uppercase tracking-wide mb-1.5 block">Badges</label>
        <BadgeSlots matrixId={matrixId} editable />
        <button
          type="button"
          // dispatchClaimable, not a bare CustomEvent: the hub's one-host
          // guard reads defaultPrevented — cancelable only (useUserMenuEvents.ts).
          onClick={() => { dispatchClaimable("bb:open-store", { tab: "spend" }); }}
          className="mt-1.5 text-2xs text-yellow-500/90 hover:text-yellow-400 transition-colors"
        >
          Get badges &amp; slots in the {currencyTitle()} store →
        </button>
      </div>

      <div className="flex gap-2">
        {/* Cancel only. The plain "← Back" this used to fall back to is gone:
            the editor is a PAGE of the account card now and the shell's header
            arrow is the way back, on every page, in one place. What survives is
            the rename confirm's escape hatch, which is a different action. */}
        {confirmPending && (
          <button
            onClick={() => setConfirmPending(false)}
            className="flex-1 px-3 py-1.5 text-xs text-secondary hover:text-strong hover:bg-surface-1 rounded transition-colors"
          >
            Cancel
          </button>
        )}
        <button
          onClick={saveName}
          disabled={saving || !nameInput.trim() || cooldownMsLeft > 0}
          className={`flex-1 px-3 py-1.5 text-xs text-strong rounded border transition-colors disabled:opacity-30 ${
            confirmPending
              ? "bg-amber-500/20 hover:bg-amber-500/30 border-amber-400/30"
              : "bg-surface-2 hover:bg-surface-3 border-edge"
          }`}
        >
          {saved ? "Saved ✓" : saving ? "Saving…" : confirmPending ? "Confirm" : "Save"}
        </button>
      </div>
    </div>
  );
}
