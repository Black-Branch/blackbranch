"use client";

import { useState } from "react";
import nextDynamic from "next/dynamic";
import { Palette } from "@phosphor-icons/react/dist/ssr";
import { Window } from "@/app/components/chrome";
import { useNarrowViewport } from "@/app/lib/useNarrowViewport";
import { useWindowDock } from "@/app/lib/chrome/windowDock";
import ProfileCardBody from "./ProfileCardBody";
import ProfileEditor from "./ProfileEditor";
import LinkedAccountsInline from "./LinkedAccountsInline";
import PrivacySettings from "./PrivacySettings";
import ChatAppearanceBody from "./ChatAppearanceBody";
import SupportContent from "./SupportContent";
import { StoreContent } from "@/app/features/store";
import { type MenuTab } from "@/app/lib/settingsMenu";
import { PAGES, PAGE_MIN_W, isPageKey, type PageKey } from "@/app/lib/accountPages";
import { type CardPage } from "@/app/lib/cardStack";
import { currentAvatarVersion, bumpAvatarVersion, patchProfileCardMe } from "@/app/lib/profileCardPrefetch";

// THE account card: one card with internal navigation. The profile card, chat
// appearance, support and the points store are pages in one shell, with one
// persisted geometry and a `‹` in the header — move the card once and
// everything is there. (The mod panel is its own tool Window, not a page — see
// ModWindow.)
//
// The stack itself lives in the HOST (useCardStack) because the card is
// unmounted while closed — see that file. This component owns only what is
// per-card: which tab the appearance page is on, and the avatar cache-buster
// the Edit page bumps.
//
// Devices & Security drags in the Matrix crypto stack (useMatrixSettings →
// matrix-js-sdk crypto-api). Chunk-split so opening THAT page — not every page
// load — pays for it.
const MatrixSettings = nextDynamic(() => import("./MatrixSettings"), {
  ssr: false,
  loading: () => <div className="p-4 text-xs text-muted">Loading security settings…</div>,
});

export type SupportSection = "subscription" | "donation" | "gift";

export default function AccountCard({
  matrixId,
  canonicalId = null,
  stack,
  onNavigate,
  onBack,
  onClose,
  giftTarget = null,
  supportSections = null,
  storeTab = "topup",
  onOpenMod,
  onOpenAdmin,
  onShowTimestampsChange,
  onShowMatrixNameChange,
  displayName,
}: {
  matrixId: string;
  canonicalId?: string | null;
  stack: readonly CardPage[];
  onNavigate: (page: CardPage) => void;
  onBack: () => void;
  onClose: () => void;
  /** Scoped-open context, set by whichever event opened the page. */
  giftTarget?: string | null;
  supportSections?: SupportSection[] | null;
  storeTab?: "topup" | "spend" | "history";
  /** Opens the host's ModWindow — the mod panel is a tool window, not a page. */
  onOpenMod: () => void;
  /** Opens the host's AdminWindow (admins only — the row shows to admins). */
  onOpenAdmin?: () => void;
  onShowTimestampsChange?: (v: boolean) => void;
  onShowMatrixNameChange?: (v: boolean) => void;
  /** Threaded through by every caller for their own isPopout-gated behaviour
   *  (ChatSidebar/ChatInput/UserMenu). AccountCard itself has no use for it
   *  (the header has no "Popout chat" button) — kept in the
   *  type only so UserMenu's pass-through isn't a prop-shape break. */
  isPopout?: boolean;
  /** The profile root (`top.title` is empty there) has no title of its own —
   *  the host already has this from its one source (UserMenu's `formatMxid`);
   *  read it here rather than re-deriving it, so the header can't disagree
   *  with the avatar it sits under. */
  displayName?: string;
}) {
  const narrow = useNarrowViewport();
  const win = useWindowDock("account", narrow);
  // Opens on Chat text — the section a viewer is most likely to have come for.
  const [appearanceTab, setAppearanceTab] = useState<MenuTab>("text");
  const [avatarVer, setAvatarVer] = useState(currentAvatarVersion);

  const top = stack[stack.length - 1] ?? PAGES.profile;
  const key: PageKey = isPageKey(top.key) ? top.key : "profile";
  const go = (page: CardPage) => onNavigate(page);

  const body = (() => {
    switch (key) {
      case "edit":
        return (
          <ProfileEditor
            matrixId={matrixId}
            onBack={onBack}
            onAvatarChanged={() => {
              // Bump the SHARED version first, then announce — listeners (the
              // chat-bar button, the community rail) re-read off the fresh value.
              setAvatarVer(bumpAvatarVersion());
              window.dispatchEvent(new Event("bb:avatar-changed"));
            }}
            onBannerChanged={(mxc) => {
              // Keep the cached batch honest so returning to the profile page
              // doesn't flash the pre-upload banner before revalidation lands.
              patchProfileCardMe(matrixId, { bannerMxc: mxc });
            }}
          />
        );
      case "security":
        return (
          <MatrixSettings
            onEncryptionChange={(s) =>
              // Broadcast so every traffic-light dot (chat bar, rail, the
              // card's own encryption row) updates in place.
              window.dispatchEvent(new CustomEvent("bb:encryption-status", { detail: s }))
            }
          />
        );
      case "accounts":
        return <LinkedAccountsInline />;
      case "privacy":
        return <PrivacySettings />;
      case "appearance":
        return (
          <ChatAppearanceBody
            tab={appearanceTab}
            onTab={setAppearanceTab}
            onShowTimestampsChange={onShowTimestampsChange}
            onShowMatrixNameChange={onShowMatrixNameChange}
          />
        );
      case "support":
        return (
          <div className="p-4">
            <SupportContent
              onClose={onClose}
              initialGiftRecipient={giftTarget}
              sections={supportSections}
              // AccountCard only ever mounts for a signed-in matrixId — see
              // its own props below.
              signedIn
            />
          </div>
        );
      case "store":
        return (
          <div className="p-4">
            <StoreContent onClose={onClose} initialTab={storeTab} />
          </div>
        );
      default:
        return (
          <ProfileCardBody
            matrixId={matrixId}
            canonicalId={canonicalId}
            avatarVer={avatarVer}
            onNavigate={(k) => go(PAGES[k])}
            onOpenMod={onOpenMod}
            onOpenAdmin={onOpenAdmin}
          />
        );
    }
  })();

  return (
    <Window
      // The HOST picks the presentation from the one device signal the app
      // already has — Window itself never reads matchMedia. Crossing the
      // breakpoint swaps components live; safe: the stack and all page state
      // live up here. The appearance page is a PANEL/peek on narrow: its
      // settings are previewed against the live chat, and a full pane-height
      // task would hide the thing being adjusted. Task panes stay full
      // pane-height. Unlike the breakpoint swap, the peek↔task swap on in-card
      // navigation never remounts Window: presentation stays "panel"
      // throughout, only `kind` changes on the SAME PanelWindow instance, so
      // the back sentinel's register/release (the StrictMode pin) is untouched
      // — only the sibling-inert effect (keyed on `kind`) reacts.
      presentation={win.presentation}
      dock={win.dock}
      kind={key === "appearance" ? "peek" : "task"}
      name={top.title || displayName || "Profile"}
      mark={key === "appearance" ? <Palette size={14} weight="bold" /> : undefined}
      title={top.title}
      storageKey="bb_profilecard_geom"
      defaultSize={{ w: 384, h: 560 }}
      fitHeight
      minWidth={PAGE_MIN_W[key]}
      stack={stack}
      onBack={onBack}
      onClose={onClose}
    >
      {body}
    </Window>
  );
}
