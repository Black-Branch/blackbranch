"use client";

import { useCallback, useEffect, useState } from "react";
import { CHAT_FONT } from "@/app/lib/chatFont";
import { useMatrixIdentity } from "@/app/lib/MatrixClientContext";
import { useUserMenuEvents } from "@/app/lib/useUserMenuEvents";
import { useEncryptionStatus } from "@/app/lib/useEncryptionStatus";
import { useCardStack } from "@/app/lib/useCardStack";
import { avatarBg } from "@/app/lib/avatarColor";
import { keepFocus } from "@/app/lib/keepFocus";
import { formatMxid } from "@/app/lib/matrixDisplay";
import { PAGES } from "@/app/lib/accountPages";
import AccountCard, { type SupportSection } from "./AccountCard";
import { ModWindow, isModPlace, type ModPlace } from "@/app/features/moderation";
import { AdminWindow, searchAdminPlaces } from "@/app/features/instance";
import {
  prefetchProfileCard,
  currentAvatarVersion,
  bumpAvatarVersion,
} from "@/app/lib/profileCardPrefetch";

// The account entry point: the user's avatar (with the crypto traffic-light
// dot) lives in the chat typing bar and opens the account card directly — there
// is no menu list. This component is a thin mount: the avatar button, the
// window-event hub, and ONE AccountCard. Every `bb:open-*` event opens a page
// of that one card, so each handler is a navigation instead of a mount.

// Map a section keyword carried on the open-support event to the set of
// SupportContent sections to show. "subscribe" opens the combined sub+gift page
// (the Subscribe and Gift buttons share it); "donation"/"gift" open just one.
function sectionsForKey(key?: string): SupportSection[] | null {
  if (key === "donation") return ["donation"];
  if (key === "gift") return ["gift"];
  if (key === "subscribe") return ["subscription", "gift"];
  return null; // all three
}

export default function UserMenu({
  matrixId: matrixIdProp,
  canonicalId = null,
  onShowTimestampsChange,
  onShowMatrixNameChange,
  isPopout,
}: {
  matrixId?: string | null;
  canonicalId?: string | null;
  onShowTimestampsChange?: (v: boolean) => void;
  onShowMatrixNameChange?: (v: boolean) => void;
  isPopout?: boolean;
}) {
  const { stack, open, back, close, toggle } = useCardStack();
  // Scoped-open context for the pages that take it.
  const [giftTarget, setGiftTarget] = useState<string | null>(null);
  const [supportSections, setSupportSections] = useState<SupportSection[] | null>(null);
  const [storeTab, setStoreTab] = useState<"topup" | "spend" | "history">("topup");
  const [modTarget, setModTarget] = useState<string | undefined>(undefined);
  const [modOpen, setModOpen] = useState(false);
  // The Admin window: opened from the mod window's band and the profile card's
  // row, admins only.
  const [adminOpen, setAdminOpen] = useState(false);
  // Where each panel opens when the other panel's search sent the viewer there.
  const [modPlace, setModPlace] = useState<ModPlace | undefined>(undefined);
  const [adminPlace, setAdminPlace] = useState<string | undefined>(undefined);
  // Shared monotonic cache-buster (profileCardPrefetch) — see ProfileCardBody.
  const [avatarVer, setAvatarVer] = useState(currentAvatarVersion);
  const [avatarOk, setAvatarOk] = useState(true);

  const { matrixId: sessionMatrixId } = useMatrixIdentity();
  const { dotClass } = useEncryptionStatus();
  // Self-source the identity when the host doesn't pass it (Matrix room input)
  const matrixId = matrixIdProp ?? sessionMatrixId;

  useUserMenuEvents({
    onSupport: (detail) => {
      const gift = detail?.giftUsername ?? null;
      setGiftTarget(gift);
      // A gift target with no explicit section implies the gift section.
      setSupportSections(sectionsForKey(detail?.section) ?? (gift ? ["gift"] : null));
      open(PAGES.support);
    },
    // Withheld without an identity on purpose: this
    // component mounts signed out (it returns null after the hooks), and the
    // hub only claims open-store when a handler is present — so a signed-out
    // pill click stays UNCLAIMED and the pill's sign-in fallback fires,
    // instead of this claiming the event and then rendering nothing.
    onStore: matrixId ? (detail) => {
      setStoreTab(detail?.tab === "history" ? "history" : detail?.tab === "spend" ? "spend" : "topup");
      open(PAGES.store);
    } : undefined,
    onModPanel: (detail) => {
      setModTarget(detail?.target || undefined);
      setModOpen(true);
    },
    onAdminPanel: () => setAdminOpen(true),
    onProfileCard: () => open(),
    // The secure-account nudge jumps straight to Devices & Security.
    onAccountSettings: () => open(PAGES.security),
    // The link-account nudge jumps straight to Linked accounts.
    onLinkedAccounts: () => open(PAGES.accounts),
    onChatAppearance: () => open(PAGES.appearance),
    // Matrix → site reconcile (fired on client-ready) may have pulled in an
    // avatar changed externally; refresh the displayed thumbnail in place.
    onProfileSynced: () => { setAvatarOk(true); setAvatarVer(bumpAvatarVersion()); },
    // The Edit page announces avatar changes (same event the rail avatar
    // listens to) — refresh the chat-bar thumbnail too. It already bumped the
    // shared version before dispatching; just re-read it.
    onAvatarChanged: () => { setAvatarOk(true); setAvatarVer(currentAvatarVersion()); },
  });

  // Account-link OAuth callbacks land on "/" with ?linked= / ?error=&platform=
  // intact (oauthBannerSurface.test.ts). The card host is what can surface the
  // result, so it jumps straight to Linked accounts; AccountLinkPanel's
  // BannerReader then consumes the params and strips them in place. Keyed on
  // linked OR error+platform — a bare ?error= belongs to other flows.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("linked") || (p.get("error") && p.get("platform"))) open(PAGES.accounts);
    // A signed-out Subscribe/Gift click parked its intent before the sign-in
    // redirect (StreamView.openSupport) — resume it here, the
    // first signed-in mount after the round trip, so the user lands back in
    // the flow they came for instead of hunting for the button again.
    const pending = sessionStorage.getItem("bb_pending-support");
    if (pending) {
      sessionStorage.removeItem("bb_pending-support");
      // Microtask defer keeps the sync setState out of the effect pass (the
      // refreshMe idiom in SupportContent).
      Promise.resolve().then(() => {
        setSupportSections(sectionsForKey(pending) ?? null);
        open(PAGES.support);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot read of the OAuth landing URL on mount; re-running on open() identity churn would re-pop a card the user closed
  }, []);

  // Warm the card's whole data batch BEFORE it opens: hover/focus on the avatar button covers pointer users right before the
  // click, and an idle-scheduled prefetch after sign-in covers touch (no hover)
  // plus makes the very first open warm too. The cache coalesces, so these
  // triggers never stack requests.
  const warmCard = useCallback(() => {
    if (!matrixId) return;
    prefetchProfileCard({ matrixId, canonicalId: canonicalId ?? null }).catch(() => {});
  }, [matrixId, canonicalId]);
  useEffect(() => {
    if (!matrixId) return;
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warmCard, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = window.setTimeout(warmCard, 1500);
    return () => window.clearTimeout(t);
  }, [matrixId, warmCard]);

  if (!matrixId) return null;

  const displayName = formatMxid(matrixId);

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        // Opening a window must not cost the keyboard (keepFocus.ts): a blur
        // here would close the phone keyboard and drop the keyboard-lifted
        // layout mid-way through the card's entry animation. The card is a
        // panel with the composer live beneath it, so keeping the keyboard is
        // the correct end state, not a side effect.
        onMouseDown={keepFocus}
        onPointerEnter={warmCard}
        onFocus={warmCard}
        title={`${displayName} — profile`}
        className="relative shrink-0 mr-1"
        // Avatar scales with the chat font size (2em of the chat size ≈ 28px
        // at the default 0.875rem)
        style={{ fontSize: CHAT_FONT }}
      >
        {avatarOk ? (
          <img
            src={`/api/avatar/me?v=${avatarVer}`}
            alt={displayName}
            onError={() => setAvatarOk(false)}
            className="w-(--composer-ctl) h-(--composer-ctl) rounded-full object-cover"
          />
        ) : (
          <span
            className="w-(--composer-ctl) h-(--composer-ctl) rounded-full flex items-center justify-center font-bold text-strong"
            style={{ backgroundColor: avatarBg(displayName) }}
          >
            {/* nested so the smaller letter doesn't shrink the 2em box basis */}
            <span className="text-[0.8em]">{displayName.charAt(0).toUpperCase()}</span>
          </span>
        )}
        {dotClass && (
          <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-canvas ${dotClass}`} />
        )}
      </button>

      {stack && (
        <AccountCard
          matrixId={matrixId}
          canonicalId={canonicalId}
          stack={stack}
          onNavigate={open}
          onBack={back}
          onClose={close}
          giftTarget={giftTarget}
          supportSections={supportSections}
          storeTab={storeTab}
          onOpenMod={() => setModOpen(true)}
          onOpenAdmin={() => setAdminOpen(true)}
          onShowTimestampsChange={onShowTimestampsChange}
          onShowMatrixNameChange={onShowMatrixNameChange}
          isPopout={isPopout}
          displayName={displayName}
        />
      )}

      {modOpen && (
        <ModWindow
          target={modTarget}
          place={modPlace}
          searchAdmin={searchAdminPlaces}
          onOpenAdmin={(p) => { setAdminPlace(p); setAdminOpen(true); }}
          onClose={() => {
            setModOpen(false);
            setModPlace(undefined);
            // A shield-opened target must not leak into the next row-opened
            // panel — clear it with the window, not on open.
            setModTarget(undefined);
          }}
        />
      )}

      {adminOpen && (
        <AdminWindow
          place={adminPlace}
          onOpenMod={(p) => { setModPlace(isModPlace(p) ? p : undefined); setModOpen(true); }}
          onClose={() => { setAdminOpen(false); setAdminPlace(undefined); }}
        />
      )}
    </>
  );
}
