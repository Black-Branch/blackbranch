"use client";

import { useEffect, useRef } from "react";
// .ts extension on purpose: this module now runs under `node --test` (its
// render test), and Node's strip-only loading resolves no extensionless paths.
import { claimEvent } from "./claimableEvent.ts";

// The user-menu window-event hub. Anything in the app can open an account
// surface without importing the component that hosts it — UserCard's Gift
// button, ChatInput's cheer chip, the community rail's avatar, the
// secure-account nudge, the profile card's own rows — by dispatching one of
// these events; the mounted UserMenu supplies the handlers (every handler is
// optional, so a lean consumer like the rail's avatar button can subscribe to
// just the entry it needs).
//
//   bb:open-support           detail { giftUsername?, section? }
//   bb:open-store             detail { tab? }
//   bb:open-profile-card      (no detail — claimable handshake
//                                  (claimableEvent.ts): a mounted hub claims it
//                                  so the /community rail's fallback host stays
//                                  dead wherever a UserMenu is mounted; same
//                                  pattern as open-modpanel)
//   bb:open-account-settings  (no detail — card jumps to Devices & Security)
//   bb:open-linked-accounts   (no detail — card jumps to Linked accounts;
//                                  the link-account nudge's CTA)
//   bb:open-chat-appearance   (no detail)
//   bb:open-modpanel          detail { target? } — claimable, same as
//                                  open-profile-card. Opens the ModWindow tool
//                                  window; its host is whoever hosts the card
//                                  (UserMenu claims and opens its window).
//   bb:open-adminpanel        (no detail) — claimable, same as open-modpanel: opens the
//                                  AdminWindow (admins only — the rows that send it
//                                  are admin-only; every admin route re-checks)
//   bb:profile-synced         (no detail — avatar may have changed)
//   bb:avatar-changed         (no detail — ProfileEditor uploaded a new
//                                  avatar; thumbnails re-read the shared
//                                  version counter in profileCardPrefetch)
//
// ONE HUB ANSWERS AN OPEN: narrow layouts mount MORE THAN ONE UserMenu
// (ChatSidebar's header + ChatInput's / MatrixInput's), and if every mounted
// hub answered every open event, "Your profile" would open TWO stacked Account
// cards. claimEvent() only tells the DISPATCHER someone is hosting; it does
// not silence sibling hubs. So every open handler checks `e.defaultPrevented`
// first — the first-registered hub claims, later hubs stand down — which
// requires every dispatcher of these events to send a CANCELABLE event via
// dispatchClaimable (preventDefault on a non-cancelable event is a silent
// no-op and the guard never trips; userCardData.test.ts's hub test plus the
// source scan in useUserMenuEvents.test.ts pin both halves).
// The two notification events (profile-synced, avatar-changed) are BROADCASTS
// and deliberately still reach every hub.

export type OpenSupportDetail = { giftUsername?: string; section?: string };
export type OpenStoreDetail = { tab?: string };
export type OpenModPanelDetail = { target?: string };

export function useUserMenuEvents(h: {
  onSupport?: (d: OpenSupportDetail | undefined) => void;
  onStore?: (d: OpenStoreDetail | undefined) => void;
  onModPanel?: (d: OpenModPanelDetail | undefined) => void;
  onAdminPanel?: () => void;
  onProfileCard?: () => void;
  onAccountSettings?: () => void;
  onLinkedAccounts?: () => void;
  onChatAppearance?: () => void;
  onProfileSynced?: () => void;
  onAvatarChanged?: () => void;
}): void {
  // Handlers live in a ref so the listeners register exactly once — the caller
  // may pass fresh closures every render without re-subscribing.
  const ref = useRef(h);
  useEffect(() => {
    ref.current = h;
  });

  useEffect(() => {
    const onSupport = (e: Event) => {
      if (e.defaultPrevented || !ref.current.onSupport) return;
      claimEvent(e);
      ref.current.onSupport((e as CustomEvent).detail as OpenSupportDetail | undefined);
    };
    const onStore = (e: Event) => {
      // Claimable: the currency pill renders signed OUT, and its dispatch would
      // otherwise go to nobody (UserMenu withholds this handler
      // without a matrixId) — a dead click on a money surface. Claiming tells
      // the pill a host took it; unclaimed, the pill falls back to sign-in.
      if (e.defaultPrevented || !ref.current.onStore) return;
      claimEvent(e);
      ref.current.onStore((e as CustomEvent).detail as OpenStoreDetail | undefined);
    };
    const onModPanel = (e: Event) => {
      // Claimable, like open-profile-card: a mounted host claims it so the
      // /community rail's fallback stays dead wherever a UserMenu is mounted,
      // and exactly one host ever opens the window.
      if (e.defaultPrevented || !ref.current.onModPanel) return;
      claimEvent(e);
      ref.current.onModPanel((e as CustomEvent).detail as OpenModPanelDetail | undefined);
    };
    const onAdminPanel = (e: Event) => {
      if (e.defaultPrevented || !ref.current.onAdminPanel) return;
      claimEvent(e);
      ref.current.onAdminPanel();
    };
    const onProfileCard = (e: Event) => {
      // Claim the claimable open-profile-card event so the /community rail
      // only hosts its own fallback card when NO UserMenu is mounted to
      // handle it.
      if (e.defaultPrevented || !ref.current.onProfileCard) return;
      claimEvent(e);
      ref.current.onProfileCard();
    };
    const onAccountSettings = (e: Event) => {
      if (e.defaultPrevented || !ref.current.onAccountSettings) return;
      claimEvent(e);
      ref.current.onAccountSettings();
    };
    const onLinkedAccounts = (e: Event) => {
      if (e.defaultPrevented || !ref.current.onLinkedAccounts) return;
      claimEvent(e);
      ref.current.onLinkedAccounts();
    };
    const onChatAppearance = (e: Event) => {
      if (e.defaultPrevented || !ref.current.onChatAppearance) return;
      claimEvent(e);
      ref.current.onChatAppearance();
    };
    // Broadcasts — every hub refreshes; claiming these would break the others.
    const onProfileSynced = () => ref.current.onProfileSynced?.();
    const onAvatarChanged = () => ref.current.onAvatarChanged?.();

    window.addEventListener("bb:open-support", onSupport);
    window.addEventListener("bb:open-store", onStore);
    window.addEventListener("bb:open-modpanel", onModPanel);
    window.addEventListener("bb:open-adminpanel", onAdminPanel);
    window.addEventListener("bb:open-profile-card", onProfileCard);
    window.addEventListener("bb:open-account-settings", onAccountSettings);
    window.addEventListener("bb:open-linked-accounts", onLinkedAccounts);
    window.addEventListener("bb:open-chat-appearance", onChatAppearance);
    window.addEventListener("bb:profile-synced", onProfileSynced);
    window.addEventListener("bb:avatar-changed", onAvatarChanged);
    return () => {
      window.removeEventListener("bb:open-support", onSupport);
      window.removeEventListener("bb:open-store", onStore);
      window.removeEventListener("bb:open-modpanel", onModPanel);
      window.removeEventListener("bb:open-adminpanel", onAdminPanel);
      window.removeEventListener("bb:open-profile-card", onProfileCard);
      window.removeEventListener("bb:open-account-settings", onAccountSettings);
      window.removeEventListener("bb:open-linked-accounts", onLinkedAccounts);
      window.removeEventListener("bb:open-chat-appearance", onChatAppearance);
      window.removeEventListener("bb:profile-synced", onProfileSynced);
      window.removeEventListener("bb:avatar-changed", onAvatarChanged);
    };
  }, []);
}
