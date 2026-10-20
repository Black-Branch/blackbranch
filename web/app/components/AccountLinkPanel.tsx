"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import PlatformIcon, { PLATFORM_COLORS } from "@/app/components/PlatformIcon";
import { platformLabel, canCrossPost } from "@/app/lib/platforms";
import { LINKING_IS_PRIVATE, POSTING_IS_SEPARATE, linkedBanner } from "@/app/lib/crossPostCopy";
import { wsGet } from "@/app/lib/windowScoped";
import { postJson, postJsonOrThrow } from "@/app/lib/http";
import { fullDate } from "@/app/lib/textFormat";
import EmptyState from "./EmptyState";
import { Toggle } from "./SettingsControls";

type LinkedAccount = {
  platform: string;
  displayName: string | null;
  linkedAt: string;
  /** Config scopes this link predates — non-empty ⇒ show the relink CTA. */
  missingScopes?: string[];
};

type Props = {
  linked: LinkedAccount[];
  configuredPlatforms: string[];
  /** Platforms shown but not yet linkable (e.g. YouTube pending Google
   *  verification) — rendered greyed-out with a note instead of a Link button. */
  pendingPlatforms?: string[];
  /** site.users.show_links (v153): the person shows their linked platforms on their profile. */
  showLinks?: boolean;
};

// Reads ?linked= / ?error= from the URL after OAuth redirect and fires setBanner.
// Must be inside Suspense because useSearchParams() suspends during SSR.
function BannerReader({ onBanner }: { onBanner: (b: { type: "ok" | "err"; msg: string }) => void }) {
  const searchParams = useSearchParams();
  useEffect(() => {
    const linkedParam = searchParams.get("linked");
    const errorParam = searchParams.get("error");
    if (linkedParam) {
      // The moment of linking: say what now happens to their messages (the chat
      // box posts to every linked platform by default) and where to change it.
      // pending=1: linked, but they've never chatted on that platform, so the
      // stream-identity join waits for their first message — say so up front.
      onBanner({
        type: "ok",
        msg: linkedBanner(linkedParam, {
          crossPost: canCrossPost(linkedParam),
          storedDest: wsGet("chatTargetDest"),
          pending: searchParams.get("pending") === "1",
        }),
      });
      // Preserve window.history.state (5c-r): replaceState(null, …) wiped the
      // Next App Router's state off this entry — and any armed back-sentinel
      // mark with it. Only the URL params are being consumed here.
      window.history.replaceState(window.history.state, "", window.location.pathname);
    } else if (errorParam === "no_youtube_channel") {
      onBanner({
        type: "err",
        msg: "That Google account has no YouTube channel — create one on youtube.com first, then re-link.",
      });
      window.history.replaceState(window.history.state, "", window.location.pathname);
    } else if (errorParam === "permission_declined") {
      onBanner({
        type: "err",
        msg: "A required permission was unchecked on the consent screen — re-link and keep every permission enabled (YouTube needs “Manage your YouTube account” to post chat).",
      });
      window.history.replaceState(window.history.state, "", window.location.pathname);
    } else if (errorParam) {
      onBanner({ type: "err", msg: `Could not link account: ${errorParam.replace(/_/g, " ")}.` });
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot consumption of the OAuth redirect params: it banners and then replaceState()s them out of the URL. replaceState does not update useSearchParams, so re-running on a searchParams/onBanner identity change would re-show a banner for a link that already happened
  }, []);
  return null;
}

export default function AccountLinkPanel({ linked, configuredPlatforms, pendingPlatforms = [], showLinks: initialShowLinks = false }: Props) {
  const [accounts, setAccounts] = useState<LinkedAccount[]>(linked);
  const [showLinks, setShowLinks] = useState(initialShowLinks);
  const [savingShow, setSavingShow] = useState(false);

  // The person's own choice to show their linked platforms (owner decision 2026-10-17). Saved
  // first, shown after: a switch that flips before the save would claim a privacy state the
  // server does not hold.
  async function toggleShowLinks() {
    const next = !showLinks;
    setSavingShow(true);
    try {
      const res = await postJson("/api/account-links", { showLinks: next }, "PATCH");
      if (!res.ok) throw new Error("save failed");
      setShowLinks(next);
    } catch {
      setBanner({ type: "err", msg: "Could not save that — try again in a moment." });
    } finally {
      setSavingShow(false);
    }
  }
  const [pending, setPending] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  // stream.place is AT Protocol OAuth — it starts from the user's handle.
  // Collected with an inline row, not window.prompt: a
  // native prompt is unstyled, blocks the tab, and offers no example text a
  // user can see while typing.
  const [spHandleOpen, setSpHandleOpen] = useState(false);
  const [spHandle, setSpHandle] = useState("");

  async function handleLink(platform: string) {
    let body: { handle: string } | undefined;
    if (platform === "streamplace") {
      const handle = spHandle.trim();
      if (!handle) { setSpHandleOpen(true); return; }
      body = { handle };
      setSpHandleOpen(false);
    }
    setPending(platform);
    try {
      const { authorizationUrl } = await postJsonOrThrow<{ authorizationUrl: string }>(
        `/api/auth/link/${platform}/initiate`,
        body
      );
      window.location.href = authorizationUrl;
    } catch {
      setBanner({ type: "err", msg: `Failed to start ${platformLabel(platform)} OAuth.` });
      setPending(null);
    }
  }

  async function handleUnlink(platform: string) {
    setPending(platform);
    try {
      const res = await postJson("/api/account-links", { platform }, "DELETE");
      if (res.status === 503) {
        // Nothing was changed (the identity split could not be made): the link stays, try again.
        setBanner({ type: "err", msg: `Couldn't unlink ${platformLabel(platform)} right now — nothing was changed. Try again in a moment.` });
        return;
      }
      if (!res.ok) throw new Error("unlink failed");
      setAccounts(prev => prev.filter(a => a.platform !== platform));
      setBanner({ type: "ok", msg: `${platformLabel(platform)} unlinked.` });
      // Let same-tab consumers (ChatInput's destination toggle) drop it live.
      window.dispatchEvent(new Event("bb:accounts-changed"));
    } catch {
      setBanner({ type: "err", msg: `Failed to unlink ${platformLabel(platform)}.` });
    } finally {
      setPending(null);
    }
  }

  const linkedMap = new Map(accounts.map(a => [a.platform, a]));

  return (
    <div className="space-y-3">
      <Suspense fallback={null}>
        <BannerReader onBanner={setBanner} />
      </Suspense>
      {banner && (
        <div
          // The OAuth redirect lands here silently for a screen reader — the
          // link outcome is the one thing the user came back to learn.
          // Success is polite; a failed link interrupts.
          role={banner.type === "ok" ? "status" : "alert"}
          className={`rounded-lg px-4 py-3 text-sm ${
            banner.type === "ok"
              ? "bg-emerald-900/40 border border-emerald-700/40 text-emerald-300"
              : "bg-red-900/40 border border-red-700/40 text-red-300"
          }`}
        >
          {banner.msg}
          <button
            onClick={() => setBanner(null)}
            className="ml-3 text-current opacity-50 hover:opacity-100"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Two separate things, said separately (crossPostCopy.ts — the same pair About and the
          legal page carry): the LINK is private; POSTING is on by default for a linked account. */}
      <div className="rounded-xl border border-edge bg-surface-1 px-4 py-3 space-y-2 text-xs text-muted">
        <p>
          {LINKING_IS_PRIVATE} Other people see each of your accounts under its own name and are not
          told they belong to the same person, unless you turn on the switch below.
          Moderators can see which accounts are linked, to moderate the chat.
        </p>
        <p>
          {POSTING_IS_SEPARATE} So anyone watching both can see it was you. To post here only, choose
          it with the Send-to button in the chat box; that choice is remembered.
        </p>
        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-sm text-body">Show my linked platforms on my profile</span>
          <Toggle
            on={showLinks}
            onToggle={() => { void toggleShowLinks(); }}
            disabled={savingShow}
            label="Show my linked platforms on my profile"
          />
        </div>
        <p>Unlinking an account, or turning the switch off, hides it again.</p>
      </div>

      {configuredPlatforms.length === 0 && pendingPlatforms.length === 0 && (
        <EmptyState>No platforms configured yet.</EmptyState>
      )}

      {configuredPlatforms.map(platform => {
        const account = linkedMap.get(platform);
        const isLinked = !!account;
        const isBusy = pending === platform;
        const color = PLATFORM_COLORS[platform] ?? "#888";
        const label = platformLabel(platform);

        return (
          <div
            key={platform}
            className="flex items-center gap-4 rounded-xl border border-edge bg-surface-1 px-4 py-3"
          >
            <div
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg"
              style={{ backgroundColor: `${color}22`, color }}
            >
              <PlatformIcon platform={platform} size="1.1em" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-body">{label}</div>
              {isLinked ? (
                <div className="text-xs text-muted truncate">
                  {account.displayName ?? account.platform} · linked {fullDate(account.linkedAt)}
                </div>
              ) : (
                <div className="text-xs text-muted">Not linked</div>
              )}
            </div>

            {isLinked ? (
              <div className="shrink-0 flex items-center gap-3">
                {(account.missingScopes?.length ?? 0) > 0 && (
                  <button
                    onClick={() => handleLink(platform)}
                    disabled={isBusy}
                    title={`New permissions available: ${account.missingScopes!.join(", ")}`}
                    className="text-xs font-medium px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 transition-colors disabled:opacity-40"
                  >
                    {isBusy ? "…" : "Update permissions"}
                  </button>
                )}
                <button
                  onClick={() => handleUnlink(platform)}
                  disabled={isBusy}
                  className="text-xs text-muted hover:text-red-400 transition-colors disabled:opacity-40"
                >
                  {isBusy ? "…" : "Unlink"}
                </button>
              </div>
            ) : platform === "streamplace" && spHandleOpen ? (
              <div className="shrink-0 flex items-center gap-1.5">
                <input
                  value={spHandle}
                  onChange={(e) => setSpHandle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleLink(platform); }}
                  placeholder="handle, e.g. yourname.bsky.social"
                  aria-label="Your stream.place / Bluesky handle"
                  autoFocus
                  className="w-40 rounded-lg border border-edge bg-surface-1 px-2 py-1.5 text-xs text-body placeholder-muted outline-none focus:border-control-strong"
                />
                <button
                  onClick={() => handleLink(platform)}
                  disabled={isBusy || !spHandle.trim()}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg border border-edge bg-surface-1 hover:bg-surface-2 text-body transition-colors disabled:opacity-40"
                >
                  {isBusy ? "…" : "Continue"}
                </button>
                <button
                  onClick={() => { setSpHandleOpen(false); setSpHandle(""); }}
                  className="text-xs text-muted hover:text-body transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => handleLink(platform)}
                disabled={isBusy}
                className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg border border-edge bg-surface-1 hover:bg-surface-2 text-body transition-colors disabled:opacity-40"
                style={isBusy ? {} : { borderColor: `${color}44` }}
              >
                {isBusy ? "…" : `Link ${label}`}
              </button>
            )}
          </div>
        );
      })}

      {pendingPlatforms.map(platform => {
        const color = PLATFORM_COLORS[platform] ?? "#888";
        const label = platformLabel(platform);
        return (
          <div
            key={platform}
            className="flex items-center gap-4 rounded-xl border border-edge bg-surface-1 px-4 py-3 opacity-70"
          >
            <div
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg"
              style={{ backgroundColor: `${color}18`, color }}
            >
              <PlatformIcon platform={platform} size="1.1em" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-body-dim">{label}</div>
              <div className="text-xs text-muted truncate">
                Linking is pending verification — coming soon.
              </div>
            </div>

            <button
              type="button"
              disabled
              title={`${label} linking is pending verification`}
              className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg border border-edge bg-surface-1 text-muted cursor-not-allowed"
            >
              Coming soon
            </button>
          </div>
        );
      })}
    </div>
  );
}
