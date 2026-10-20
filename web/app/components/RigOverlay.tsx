"use client";

// The rig page — the ONE browser source OBS needs. It connects out to
// wss://<api>/rig with the key in its address, so it works from any network, and:
//   • plays the bot's voice and the sound alerts with <audio> elements, so they land in the OBS mix
//     through the browser source's own audio ("Control audio via OBS"), and tells the server when
//     each clip has ended (the TTS queue waits on that);
//   • draws the bot's avatar from the server's speaking latch, its mouth moving while a spoken clip
//     plays (an install's plugin may supply its own avatar — app/lib/plugins/rig.ts);
//   • reports OBS's scene and switches it on request (window.obsstudio; switching needs the source's
//     page permission at "Advanced access to OBS").
// Transparent and silent on screen apart from the avatar. Outside OBS (a browser tab, to try it), a
// small line at the top says whether it is connected and asks for a click when the browser blocks
// sound until one.

import { useEffect, useRef, useState } from "react";
import { installValue } from "@/app/lib/installValues";
import { OWNER_RIG_AVATAR } from "@/app/lib/plugins/rig";
import type { RigAvatarProps } from "@/app/lib/plugins/types";
import { parseRigFrame, rigSocketUrl, rigProtocols, OBS_LEVEL_READ_USER, OBS_LEVEL_ADVANCED } from "@/app/lib/rig/rigProtocol";

type ObsStudio = {
  getControlLevel?: (cb: (level: number) => void) => void;
  getCurrentScene?: (cb: (scene: { name?: string } | null) => void) => void;
  getScenes?: (cb: (names: string[]) => void) => void;
  setCurrentScene?: (name: string) => void;
};
declare global {
  interface Window { obsstudio?: ObsStudio }
}

const API = installValue("site.apiOrigin").replace(/\/+$/, "");
const WS = rigSocketUrl(installValue("site.apiWsOrigin"));
const ASK_MS = 1_500;

/** One obsstudio read, or null when it is missing, refused (below its permission) or slow. */
function ask<T>(fn: ((cb: (v: T) => void) => void) | undefined): Promise<T | null> {
  return new Promise((resolve) => {
    if (!fn) { resolve(null); return; }
    const t = setTimeout(() => resolve(null), ASK_MS);
    try { fn((v) => { clearTimeout(t); resolve(v); }); } catch { clearTimeout(t); resolve(null); }
  });
}

async function obsState(): Promise<{ level: number | null; scene: string | null; scenes: string[] | null }> {
  const o = typeof window !== "undefined" ? window.obsstudio : undefined;
  if (!o) return { level: null, scene: null, scenes: null };
  const level = await ask<number>(o.getControlLevel?.bind(o));
  if ((level ?? 0) < OBS_LEVEL_READ_USER) return { level, scene: null, scenes: null };
  const [scene, scenes] = await Promise.all([ask(o.getCurrentScene?.bind(o)), ask<string[]>(o.getScenes?.bind(o))]);
  return { level, scene: scene && typeof scene.name === "string" ? scene.name : null, scenes: Array.isArray(scenes) ? scenes : null };
}

/** The product's avatar: a plain round face, shown while the bot speaks; the mouth moves while a
 *  spoken clip plays. Drawn in the lower right of a 1920 × 1080 source. */
function DefaultAvatar({ speaking, talking }: RigAvatarProps) {
  return (
    <svg viewBox="0 0 200 200" width={240} height={240} aria-hidden data-avatar-talking={talking ? "1" : "0"}
      className="absolute bottom-10 right-10 transition-[opacity,transform] duration-(--anim-default)"
      style={{ opacity: speaking ? 1 : 0, transform: speaking ? "translateY(0)" : "translateY(24px)" }}>
      <defs>
        <radialGradient id="rig-face" cx="40%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#8fb8ff" />
          <stop offset="100%" stopColor="#3b5fc0" />
        </radialGradient>
      </defs>
      <circle cx="100" cy="100" r="88" fill="url(#rig-face)" stroke="#1d2f66" strokeWidth="6" />
      <ellipse cx="70" cy="82" rx="11" ry="14" fill="#0d1633" />
      <ellipse cx="130" cy="82" rx="11" ry="14" fill="#0d1633" />
      <ellipse cx="100" cy="138" rx="30" ry="7" fill="#0d1633" className={talking ? "rig-mouth-talk" : undefined} style={{ transformOrigin: "100px 138px" }} />
      <style>{`@keyframes rig-talk { 0%, 100% { transform: scaleY(1); } 50% { transform: scaleY(3); } }
        .rig-mouth-talk { animation: rig-talk 0.22s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .rig-mouth-talk { animation-duration: 0.6s; } }`}</style>
    </svg>
  );
}

export default function RigOverlay() {
  const [speaking, setSpeaking] = useState(false);
  const [talking, setTalking] = useState(0);
  const [line, setLine] = useState<string | null>(null);
  const [needsClick, setNeedsClick] = useState(false);
  const inObs = useRef(false);
  const Avatar = OWNER_RIG_AVATAR ?? DefaultAvatar;

  useEffect(() => {
    inObs.current = typeof window.obsstudio !== "undefined";
    const params = new URLSearchParams(window.location.search);
    const key = params.get("key") ?? "";
    const players = new Map<string, HTMLAudioElement>();
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1_000;
    const say = (s: string | null) => { if (!inObs.current) setLine(s); };
    const send = (frame: Record<string, unknown>) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); };

    const reportScene = async () => {
      const st = await obsState();
      if (st.scene) send({ type: "rig.scene", name: st.scene, ...(st.scenes ? { scenes: st.scenes } : {}) });
    };
    const onScene = (e: Event) => {
      const name = (e as CustomEvent<{ name?: string }>).detail?.name;
      if (typeof name === "string") send({ type: "rig.scene", name });
    };
    const onSceneList = () => { void reportScene(); };
    window.addEventListener("obsSceneChanged", onScene);
    window.addEventListener("obsSceneListChanged", onSceneList);

    const finish = (id: string, error = false) => {
      const a = players.get(id);
      if (!a) return;
      players.delete(id);
      if (a.dataset.kind === "tts") setTalking((n) => Math.max(0, n - 1));
      a.pause(); a.removeAttribute("src"); a.load();
      send({ type: "rig.ended", id, ...(error ? { error: true } : {}) });
    };
    const play = (id: string, url: string, kind: "tts" | "sound") => {
      const a = new Audio();
      a.dataset.kind = kind;
      a.preload = "auto";
      players.set(id, a);
      let began = false;
      a.addEventListener("playing", () => {
        if (began) return;
        began = true;
        if (kind === "tts") setTalking((n) => n + 1);
        send({ type: "rig.started", id, durationMs: Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : null });
      });
      a.addEventListener("ended", () => finish(id));
      a.addEventListener("error", () => finish(id, true));
      a.src = API + url;
      a.play().then(() => setNeedsClick(false)).catch((e: unknown) => {
        // A browser tab blocks sound until a click; OBS never does.
        if (e instanceof DOMException && e.name === "NotAllowedError") setNeedsClick(true);
        finish(id, true);
      });
    };

    const connect = async () => {
      if (stopped) return;
      if (!key) { say("No key in the address — copy it from Admin Panel → Utility → OBS."); return; }
      const st = await obsState();
      let opened = false;
      // The key travels in the upgrade (its subprotocol), so the server refuses a wrong one before
      // any socket exists. A key with characters a protocol name cannot hold is no key at all.
      try { ws = new WebSocket(WS, rigProtocols(key)); } catch { say("The key in this address is not valid — copy it again from Admin Panel → Utility → OBS."); return; }
      ws.onopen = () => {
        opened = true;
        backoff = 1_000;
        send({ type: "rig.hello", level: st.level, scene: st.scene, scenes: st.scenes });
      };
      ws.onmessage = (ev) => {
        const f = parseRigFrame(ev.data);
        if (!f) return;
        if (f.type === "rig.welcome") { setSpeaking(f.speaking); say("Connected — sounds, the voice and the avatar play here."); }
        else if (f.type === "rig.speaking") setSpeaking(f.on);
        else if (f.type === "rig.play") play(f.id, f.url, f.kind);
        else if (f.type === "rig.stop") finish(f.id);
        else if (f.type === "rig.setScene") {
          const o = window.obsstudio;
          if (o?.setCurrentScene && (st.level ?? 0) >= OBS_LEVEL_ADVANCED) o.setCurrentScene(f.name);
        }
      };
      ws.onclose = (ev) => {
        for (const id of [...players.keys()]) finish(id, true);
        if (stopped) return;
        // A refused upgrade (no socket at all: wrong key, module off, too many pages) shows as a
        // close that never opened; a key regenerated while connected closes with 4401.
        say(ev.code === 4401 ? "The key was changed — copy the new address from Admin Panel → Utility → OBS."
          : !opened ? "Not connected — check that this address's key is the current one (Admin Panel → Utility → OBS) and that the OBS module is on. Trying again…"
          : "Not connected — trying again…");
        retry = setTimeout(() => { void connect(); }, backoff);
        backoff = Math.min(backoff * 2, ev.code === 4401 ? 60_000 : 15_000);
      };
    };
    void connect();

    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      window.removeEventListener("obsSceneChanged", onScene);
      window.removeEventListener("obsSceneListChanged", onSceneList);
      for (const a of players.values()) a.pause();
      ws?.close();
    };
  }, []);

  return (
    <div className="absolute inset-0" data-rig-page data-speaking={speaking ? "1" : "0"} data-talking={talking > 0 ? "1" : "0"}>
      {line && (
        <p className="absolute left-3 top-3 rounded-md bg-scrim-heavy px-2 py-1 text-xs text-strong" data-rig-line>
          {line}
          {needsClick && <button type="button" className="ml-2 underline" onClick={() => setNeedsClick(false)}>Click to allow sound</button>}
        </p>
      )}
      <Avatar speaking={speaking} talking={talking > 0} />
    </div>
  );
}
