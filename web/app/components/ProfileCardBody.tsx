"use client";

import { useEffect, useState } from "react";
import PlatformIcon from "./PlatformIcon";
import PointsIcon from "./PointsIcon";
import { CreditBadge } from "./UserCard";
import { formatCoinsShort, earnedParenthetical } from "@/app/lib/coins";
import { currencyTitle } from "@/app/lib/currency";
import { useEarnedBalance, useCoinBalance } from "@/app/lib/useCoinBalance";
import { avatarBg, usernameColor } from "@/app/lib/avatarColor";
import { formatMxid } from "@/app/lib/matrixDisplay";
import { useEncryptionStatus } from "@/app/lib/useEncryptionStatus";
import { signOutEverything } from "@/app/lib/signOutEverything";
import { useBadges, badgesForMatrixId } from "@/app/lib/BadgesContext";
import { CardBanner, StyledName, Pill } from "./profileCardParts";
import PresenceStatusPicker from "./PresenceStatusPicker";
import { type ProfileCardData } from "@/app/lib/profileCardCache";
import { type PageKey } from "@/app/lib/accountPages";
import {
  prefetchProfileCard,
  readProfileCard,
  currentAvatarVersion,
} from "@/app/lib/profileCardPrefetch";
import { Brain, PaintBrushBroad, ShieldStar, SignOut, Crown, Plugs, PlugsConnected, CaretRight, CaretDown, GearSix } from "@phosphor-icons/react/dist/ssr";
import { dispatchClaimable } from "@/app/lib/claimableEvent";
import { settingsFoldLabel } from "@/app/lib/profileCardFold";
import { profileDescriptor, profileRead } from "@/app/lib/plugins/profile";

// The own-view profile card — the ROOT page of the account card. The card is
// the identity surface and every account function is a row on it: banner +
// styled name up top, stat pills, then rows (encryption, linked accounts,
// wallet, supporter, mod panel, chat appearance, sign out).
//
// It owns no chrome: AccountCard supplies the shell and the back arrow, and
// every row calls `go`, pushing a page onto the shared stack. That is what
// makes it ONE card rather than a card that spawns others.
//
// The public-facing sibling is UserCard; this one carries the own-only rows
// (wallet balance is own-view only, never public).

/**
 * One account row: a FIXED-WIDTH icon slot, then the label.
 *
 * The slot is the point: row icons are not the same width — a 1.5px status
 * dot, one to four 13px platform glyphs, a crown — so without a fixed slot no
 * two labels start at the same x and the column reads as a ragged list rather
 * than a menu. Anything variable (the linked-platform glyphs) belongs on the
 * RIGHT, where its width costs nothing.
 */
function Row({ icon, onClick, children }: {
  icon?: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-surface-1 text-xs text-secondary hover:text-strong transition-colors text-left"
    >
      {icon !== undefined && (
        <span className="w-3.5 flex items-center justify-center shrink-0">{icon}</span>
      )}
      {children}
    </button>
  );
}

export default function ProfileCardBody({
  matrixId,
  canonicalId = null,
  onNavigate,
  onOpenMod,
  onOpenAdmin = () => { dispatchClaimable("bb:open-adminpanel"); },
  avatarVer = currentAvatarVersion(), foldRows = false }: {
  matrixId: string;
  canonicalId?: string | null;
  onNavigate: (key: PageKey) => void;
  /** Opens the host's ModWindow — the mod panel is a tool window, not a page. */
  onOpenMod: () => void;
  /** Opens the host's AdminWindow. Default: the claimable open event. */
  onOpenAdmin?: () => void;
  /** Shared monotonic cache-buster (profileCardPrefetch), owned by AccountCard
   *  so an avatar uploaded on the Edit page refreshes this view behind it. */
  avatarVer?: number;
  /** Home\'s own card: the account rows sit behind one "Settings ›"
   *  row that opens them in place. The user-menu card never sets it. */
  foldRows?: boolean;
}) {
  // The loaded card batch (me/pronouns/color/style/stats/credit/links) as ONE
  // state object — it loads as one unit (profileCardPrefetch), so it renders
  // from one state. Seeded from the warm cache during the FIRST render (not in
  // an effect) so a warm card paints populated with no intermediate empty pass.
  const [data, setData] = useState<ProfileCardData | null>(() => readProfileCard(matrixId));
  // Which avatar version 404'd, rather than a boolean an effect has to reset:
  // a new version is a new URL, so it is worth another try automatically.
  const [failedAvatarVer, setFailedAvatarVer] = useState<number | null>(null);
  const avatarOk = failedAvatarVer !== avatarVer;
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [rowsOpen, setRowsOpen] = useState(false);

  const badges = useBadges();
  const coinBalance = useCoinBalance(true);
  const earnedPoints = useEarnedBalance(true);
  const { verdict, pendingVerification, dotClass } = useEncryptionStatus();

  // One batch in, one paint out — no pop-in.
  // Warm cache: the card paints fully populated immediately, then background
  // revalidation updates state silently. Cold: every section lands together.
  useEffect(() => {
    let cancelled = false;
    prefetchProfileCard({ matrixId, canonicalId: canonicalId ?? null })
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [matrixId, canonicalId]);

  const me = data?.me ?? null;
  const pronouns = data?.pronouns ?? null;
  const color = data?.color ?? null;
  const style = data?.style ?? null;
  const stats = data?.stats ?? null;
  // The install plugin's descriptor pill and read of the person (app/lib/plugins/profile.ts).
  const descriptor = stats?.found ? profileDescriptor(stats) : null;
  const read = stats?.found ? profileRead(stats) : null;
  const credit = data?.credit ?? null;
  const linkedPlatforms = data?.linkedPlatforms ?? [];
  const bannerMxc = data?.me?.bannerMxc ?? null;

  // Same rule as useSubscriptionStatus (tier != null = active own sub / staff
  // comp) — reusing the card's own /api/me response instead of a second fetch.
  const subscribed = me?.tier != null;

  const displayName = me?.displayName || formatMxid(matrixId);
  const nameColor = color ?? usernameColor(displayName);
  const ownBadges = badgesForMatrixId(badges, matrixId);
  const memberSince = me?.memberSince
    ? new Date(me.memberSince).toLocaleDateString(undefined, { month: "short", year: "numeric" })
    : null;

  return (
    <div className="pb-2">
      {/* ── Banner + avatar (shared card language) ── */}
      <CardBanner
        displayName={displayName}
        bannerMxc={bannerMxc}
        avatar={
          avatarOk ? (
            <img
              src={`/api/avatar/me?v=${avatarVer}`}
              alt={displayName}
              onError={() => setFailedAvatarVer(avatarVer)}
              className="w-16 h-16 rounded-full object-cover"
            />
          ) : (
            <span
              className="w-16 h-16 rounded-full flex items-center justify-center text-xl font-bold text-strong"
              style={{ backgroundColor: avatarBg(displayName) }}
            >
              {displayName.charAt(0).toUpperCase()}
            </span>
          )
        }
      />

      {/* ── Name (as chat renders it) + badges + identity line ── */}
      <div className="px-4 pt-2">
        {/* Edit sits BESIDE the name, not on the banner and not beside the pfp.
            It reads as "edit this identity" only when it is next to the
            identity; over the banner it would cover the image the user just
            uploaded, and beside the pfp it would look like an avatar control.
            `gap-3` rather than a margin so the wrap keeps the spacing — a long
            styled name (Elegant runs wide) drops the button to its own line. */}
        <div className="flex items-center gap-3 flex-wrap">
          <StyledName name={displayName} color={nameColor} style={style} badges={ownBadges} fit={1} />
          <button
            type="button"
            onClick={() => onNavigate("edit")}
            className="px-2 py-1 rounded-md bg-surface-2 hover:bg-surface-3 text-2xs text-body transition-colors shrink-0"
          >
            ✎ Edit Profile
          </button>
        </div>
        <p className="text-2xs text-muted mt-0.5">
          {formatMxid(matrixId)}
          {pronouns && <> · {pronouns}</>}
          {memberSince && <> · member since {memberSince}</>}
        </p>
        {me?.bio && <p className="text-xs text-body mt-1 break-words">{me.bio}</p>}
      </div>

      {/* ── Stat pills (public stream profile) ── */}
      {(credit !== null || stats?.found) && (
        <div className="px-4 pt-2.5 flex flex-wrap gap-1.5">
          {credit !== null && (
            <Pill label="Credit"><CreditBadge credit={credit} className="text-2xs" /></Pill>
          )}
          {stats?.found && (
            <>
              {stats.isMember && <Pill>{stats.subTier ?? "Member"}</Pill>}
              {descriptor && <Pill label={descriptor.label}>{descriptor.value}</Pill>}
              {stats.intelligenceTier && <Pill label="Int">{stats.intelligenceTier}</Pill>}
              <Pill label="Messages">{stats.activity ?? 0}</Pill>
              <Pill label="Streams">{stats.streams ?? 0}</Pill>
            </>
          )}
        </div>
      )}
      {read && (
        <p className="px-4 pt-2 text-xs text-body-dim italic leading-snug">
          “{read}”
        </p>
      )}

      <PresenceStatusPicker />

      {/* ── Account rows — the card IS the menu ── */}
      <div className="px-2 pt-3">
        {foldRows && (
          <Row onClick={() => setRowsOpen((v) => !v)} icon={rowsOpen ? <CaretDown size={13} weight="bold" /> : <CaretRight size={13} weight="bold" />}>
            {rowsOpen ? "Settings" : settingsFoldLabel({ verdict, pendingVerification: !!pendingVerification })}
          </Row>
        )}
        {(!foldRows || rowsOpen) && (
          <>
        <Row
          onClick={() => onNavigate("security")}
          // Always rendered now, including before Matrix has loaded — the dot
          // falls through to red for an unknown verdict, and a device that HAS
          // been set up reports green from the remembered verdict. The row used
          // to say "Encryption needs setup" with no dot beside it.
          icon={<span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />}
        >
          {pendingVerification
            ? "Verification pending"
            : verdict === "green"
            ? "Encryption ready"
            : "Encryption needs setup"}
          {!!pendingVerification && (
            <span className="text-3xs px-1 py-px rounded bg-yellow-400/20 border border-yellow-400/30 text-yellow-400 font-medium leading-none">
              verify
            </span>
          )}
        </Row>
        <Row
          onClick={() => onNavigate("accounts")}
          // An icon for the EMPTY case too — otherwise the one row most worth
          // noticing would be the only one without a glyph. Plugs vs
          // PlugsConnected says which state you are in before the label does.
          icon={linkedPlatforms.length > 0 ? <PlugsConnected size={13} /> : <Plugs size={13} />}
        >
          {linkedPlatforms.length > 0 ? "Linked accounts" : "Link a platform account"}
          {/* The per-platform glyphs move to the RIGHT: there can be four of
              them, and a variable-width leading cluster is what stopped the
              labels lining up. */}
          {linkedPlatforms.length > 0 && (
            <span className="ml-auto flex items-center gap-1 text-body-dim">
              {linkedPlatforms.map((p) => <PlatformIcon key={p} platform={p} size={13} />)}
            </span>
          )}
        </Row>
        <Row onClick={() => onNavigate("store")} icon={<PointsIcon size={13} />}>
          {currencyTitle()}
          {/* "1,475q (475q)" — total, then how much of it was EARNED rather than
              bought. Both carry the glyph: two bare numbers side by side would
              not say that either is the currency.

              The parenthetical is shown even when it equals the total: the
              case an omit-when-equal rule would hide is every viewer who has
              never bought any — almost everyone, and the people for whom "all
              of this is yours" is the useful fact. Shared with the store header
              via earnedParenthetical so the two can never disagree. */}
          {coinBalance !== null && (
            <span className="ml-auto tabular-nums text-yellow-500/90">
              {formatCoinsShort(coinBalance)}
              <span className="text-muted">{earnedParenthetical(earnedPoints)}</span>
            </span>
          )}
        </Row>
        <Row
          onClick={() => onNavigate("support")}
          // Crown, not a text "★": a text glyph among icons has a different
          // width and weight from everything else, and the mod row's
          // ShieldStar already carries a star.
          icon={<Crown size={13} weight="fill" className="text-amber-400" />}
        >
          {subscribed ? (
            <>Supporter <span className="ml-auto text-muted">Manage</span></>
          ) : (
            <span className="text-accent">Become a supporter</span>
          )}
        </Row>
        {me?.isMod && (
          <Row onClick={onOpenMod} icon={<ShieldStar size={13} weight="bold" />}>
            Mod panel
          </Row>
        )}
        {badges.isAdmin && (
          <Row onClick={onOpenAdmin} icon={<GearSix size={13} weight="bold" />}>
            Admin panel
          </Row>
        )}
        <Row onClick={() => onNavigate("appearance")} icon={<PaintBrushBroad size={13} />}>
          Chat appearance
        </Row>
        <Row onClick={() => onNavigate("privacy")} icon={<Brain size={13} />}>
          Privacy
        </Row>
        <Row
          onClick={() => {
            // First click arms; second click confirms → full session-unit
            // teardown (see signOutEverything's OTK-conflict invariant).
            if (!confirmSignOut) { setConfirmSignOut(true); return; }
            signOutEverything();
          }}
          icon={<SignOut size={13} />}
        >
          {confirmSignOut
            ? <span className="text-red-400 font-semibold">Click again to confirm</span>
            : "Sign out"}
        </Row>
          </>
        )}
      </div>

      {/* About + Terms & Privacy — this is where a signed-in viewer finds them
          (ChatSidebar's signed-out row keeps them reachable pre-auth). */}
      <p className="block px-3 pt-1.5 pb-0.5 text-center text-2xs text-muted">
        <a href="/about" className="hover:text-secondary transition-colors">
          About
        </a>
        {" · "}
        <a href="/legal" className="hover:text-secondary transition-colors">
          Terms &amp; Privacy
        </a>
      </p>
    </div>
  );
}
