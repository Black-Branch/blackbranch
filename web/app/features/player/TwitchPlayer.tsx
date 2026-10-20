"use client";
// Twitch's API CONSTRUCTS its own iframe (unlike YouTube's, which attaches to
// an existing one), so this renders a container when the API is usable and the
// plain iframe otherwise.
//
// THE CHOICE IS MADE ONCE, AT MOUNT, from the loader's synchronous ready().
// It is deliberately never upgraded when a script arrives late: swapping a
// playing iframe for an adapter-built one would black the video on every
// visit, in exchange for a benefit the viewer cannot see.
//
// THE FRAME TWITCH BUILDS IS NOT OURS. It carries Twitch's own
// allow="autoplay; fullscreen", not our IFRAME_ALLOW — so picture-in-picture has
// to be put back by hand below. Anything else we delegate to embeds through
// `allow` needs the same treatment on this path.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createTwitchAdapter } from "./adapters/twitch";
import { usePlayerAdapter } from "./usePlayerAdapter";
import { PlayerFailurePanel } from "./PlayerFailurePanel";

type TwitchPlayerProps = {
  /** The plain-iframe URL we already build — the no-script path. */
  twSrc: string;
  channel: string;
  /** The host Twitch validates `parent` against. */
  parent: string;
  muted: boolean;
  ready: (source: "twitch") => boolean;
  className: string;
  allow: string;
  referrerPolicy: "strict-origin-when-cross-origin";
  /** Which of StreamPlayerArea's two mounts this is. Reported back alongside
   *  the liveness value (not just inferred by the caller) because both mounts
   *  share ONE `onPlayerLive` setter — a consumer that only tagged by a bare
   *  "twitch" source string could not tell the Live tab's own stream apart
   *  from the Community tab's featured streamer, and a tab switch that
   *  unmounts one and mounts the other can leave a stale report from the old
   *  mount in state for one paint before the new mount's own effect fires. */
  scope: "live" | "community";
  /** This source's own liveness, for the rail's tone only — reported with
   *  `scope` so the consumer can tell which mount it came from. */
  onPlayerLive: (live: boolean | null, scope: "live" | "community") => void;
};

export function TwitchPlayer({
  twSrc, channel, parent, muted, ready, className, allow, referrerPolicy, scope, onPlayerLive,
}: TwitchPlayerProps) {
  // A mount-time initialiser, not an effect: the decision has no setter,
  // because it is never revisited.
  const [useAdapter] = useState(() => ready("twitch"));
  // useId, not a random string — a random id differs between the server and
  // client render and would break hydration.
  const containerId = `tw-player-${useId().replace(/:/g, "")}`;
  const containerRef = useRef<HTMLDivElement>(null);

  const create = useCallback(() => {
    const api = (window as unknown as { Twitch?: never }).Twitch;
    if (!api) return null;
    // Twitch.Player's constructor is the one call here we do not control, and a
    // construction-time throw would otherwise propagate into this render.
    // Containing it here degrades to "no adapter" — the hook is already inert
    // for that — rather than taking the player area down with it.
    try {
      return createTwitchAdapter({ Twitch: api, containerId, channel, parent, muted });
    } catch {
      return null;
    }
  }, [containerId, channel, parent, muted]);

  // adapters/twitch.ts's destroy() removes listeners only — Twitch's API has
  // no destroy(), so it cannot empty the <div> it built into. That makes
  // THIS the caller the adapter's own header refers to. Tied to `create`'s
  // own identity: a channel change already remounts via the `key` prop below
  // (a fresh containerId), but a `parent` or `muted` change recreates the
  // adapter WITHOUT remounting — construct-into-the-same-div would otherwise
  // stack a second Twitch.Player and its audio on top of the first.
  useEffect(() => {
    const el = containerRef.current;
    return () => { el?.replaceChildren(); };
  }, [create]);

  // RESTORES PICTURE-IN-PICTURE. Twitch's script builds its own iframe and
  // gives it allow="autoplay; fullscreen", so the adapter path would silently
  // DROP the picture-in-picture that our plain-iframe path delegates — an ad
  // blocker (no script → plain iframe) would GAIN the viewer a feature, which
  // inverts this feature's own additive rule.
  //
  // Permission Policy is fixed when a frame navigates, so `allow` has to land in
  // the window between insertion and navigation. The pristine check is what
  // makes this safe rather than lucky: reading contentWindow.location.href
  // THROWS once a cross-origin document has committed, so "about:blank" proves
  // nothing has loaded yet and the re-assign cannot black a playing video.
  // Anywhere else we do nothing and the viewer is exactly where they were.
  useEffect(() => {
    const el = containerRef.current;
    if (!useAdapter || !el) return;
    const fix = (frame: HTMLIFrameElement): boolean => {
      if ((frame.getAttribute("allow") ?? "").includes("picture-in-picture")) return true;
      let pristine = false;
      try { pristine = frame.contentWindow?.location.href === "about:blank"; } catch { pristine = false; }
      // NOT "already navigated": this is also the branch a null contentWindow
      // and a thrown cross-origin read take. All three mean the same thing —
      // not provably pristine — and the only safe answer to that is to do
      // nothing, because re-assigning src over a committed document blacks a
      // playing video.
      if (!pristine) return true;   // not provably pristine — leave it alone
      const src = frame.getAttribute("src");
      frame.setAttribute("allow", allow);
      // Setting the src attribute re-runs the iframe's navigation, now under the
      // policy above. setAttribute rather than `frame.src = frame.src`, which is
      // a self-assignment eslint rejects.
      if (src) frame.setAttribute("src", src);
      return true;
    };
    const existing = el.querySelector("iframe");
    if (existing) { fix(existing); return; }
    const obs = new MutationObserver(() => {
      const f = el.querySelector("iframe");
      if (f && fix(f)) obs.disconnect();
    });
    obs.observe(el, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [useAdapter, allow, create]);

  const { blocked, failure, playerLiveHint, dismissFailure, play } = usePlayerAdapter({
    source: "twitch", key: channel, create: useAdapter ? create : null,
  });

  // Reported up for the rail's colour and nothing else. In an effect because
  // calling a parent's setter during render is a side effect in render.
  useEffect(() => { onPlayerLive(playerLiveHint, scope); }, [playerLiveHint, onPlayerLive, scope]);

  return (
    <>
      {useAdapter ? (
        <div id={containerId} ref={containerRef} className={className} />
      ) : (
        <iframe
          src={twSrc}
          title="Live stream — Twitch"
          className={className}
          allow={allow}
          referrerPolicy={referrerPolicy}
          allowFullScreen
        />
      )}
      <PlayerFailurePanel blocked={blocked} failure={failure} onPlay={play} onDismiss={dismissFailure} />
    </>
  );
}
