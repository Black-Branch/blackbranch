// Behavior › Mention sound.
// The sounds are made here with Web Audio — no sound files, nothing to download or
// license. WHEN one plays is mentionGate.ts; this only makes the noise.
//
// Browsers refuse audio until the page has had a user gesture. The context is
// created on first use and resumed on the first press anywhere; before that a
// sound is simply skipped — never an error, never a queued burst later.

export const MENTION_SOUNDS = ["off", "ping", "chime", "pop", "knock"] as const;
export type MentionSound = (typeof MENTION_SOUNDS)[number];

type Note = { f: number; at: number; dur: number; type: OscillatorType; gain: number; slideTo?: number };

// Short and quiet on purpose: a ping in someone's headphones mid-stream.
const RECIPES: Record<Exclude<MentionSound, "off">, Note[]> = {
  ping:  [{ f: 1318, at: 0, dur: 0.35, type: "sine", gain: 0.18 }],
  chime: [
    { f: 880, at: 0, dur: 0.4, type: "sine", gain: 0.14 },
    { f: 1318, at: 0.11, dur: 0.5, type: "sine", gain: 0.12 },
  ],
  pop:   [{ f: 420, at: 0, dur: 0.09, type: "sine", gain: 0.25, slideTo: 900 }],
  knock: [
    { f: 190, at: 0, dur: 0.07, type: "triangle", gain: 0.3 },
    { f: 190, at: 0.13, dur: 0.07, type: "triangle", gain: 0.3 },
  ],
};

let ctx: AudioContext | null = null;
let unlockArmed = false;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }
  }
  if (!unlockArmed) {
    unlockArmed = true;
    const unlock = () => { void ctx?.resume().catch(() => {}); };
    // pointerdown alone is not a user activation for a TOUCH on iOS/Android
    // (pointerup/touchend/click are), so listen to all of them.
    for (const ev of ["pointerdown", "pointerup", "touchend", "click", "keydown"]) {
      window.addEventListener(ev, unlock, { capture: true, passive: true });
    }
  }
  return ctx;
}

/** Play one of the sounds now. "off", no audio support, or a page that has not
 *  been touched yet: nothing happens. */
export function playMentionSound(name: string): void {
  if (name === "off" || !(name in RECIPES)) return;
  const ac = audio();
  if (!ac) return;
  if (ac.state === "running") { schedule(ac, name); return; }
  // Suspended: the press that picked a sound in the menu is unlocking it right
  // now, so play if that lands promptly. A resume that only succeeds much later
  // (no gesture yet) must NOT play a stale sound then.
  const asked = Date.now();
  ac.resume().then(() => { if (Date.now() - asked < 500) schedule(ac, name); }).catch(() => {});
}

function schedule(ac: AudioContext, name: string): void {
  const t0 = ac.currentTime + 0.01;
  for (const n of RECIPES[name as keyof typeof RECIPES]) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = n.type;
    osc.frequency.setValueAtTime(n.f, t0 + n.at);
    if (n.slideTo) osc.frequency.exponentialRampToValueAtTime(n.slideTo, t0 + n.at + n.dur);
    g.gain.setValueAtTime(0.0001, t0 + n.at);
    g.gain.exponentialRampToValueAtTime(n.gain, t0 + n.at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.dur + 0.02);
  }
}
