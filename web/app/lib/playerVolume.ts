// Volume policy for StreamplaceThinPlayer's slider.
//
// Pure, and separate from the component, for the same reason whepEscalation.ts
// is: the parts that can break silently are decisions, not DOM. Three of them bite.
//
// 1. RESTORING A SAVED VOLUME MUST NEVER UNMUTE. `startMuted` is not a
//    preference — it is how the player satisfies autoplay policy on mobile and
//    for the "start muted" setting. If restoring a level also cleared `muted`,
//    play() would be blocked and the viewer would get a dead player with a
//    tap-to-play overlay instead of a stream. So volume and muted are
//    orthogonal, and nothing here returns a muted state.
//
// 2. SILENCE HAS TWO SOURCES. muted, and a slider dragged to zero. The UI has to
//    treat them the same (speaker-slash icon, slider at 0) or it contradicts
//    what the viewer hears — but unmuting has to restore an audible level, or
//    the button appears to do nothing.
//
// 3. A LEVEL IS PERSISTED ONLY FROM A VIEWER'S HAND. One key shared by every
//    player, written with whatever an embed's iframe reports, lets a 3% level from anywhere (a
//    tap at the left end of the in-house slider, an embed's own stored level) be restored into
//    every player — and a phone embed with no slider of its own has no way back: Android plays
//    it at 3%, which is silence. So: one key per player; an adapter writes only a level that
//    evidently changed since `ready`, unmuted and above the floor; a level below the floor
//    restores as absent; and at `ready`, an embed found at a poisoned level with nothing of ours
//    to restore is set back to the default — because each embed keeps its OWN stored volume, so
//    not writing bad levels alone would not bring the sound back. None of it unmutes.

/** @test-only migrateLegacyVolume in this file is the production reader; the tests pin the spelling
 *  The legacy single key the three players shared. Read only by the one-time migration. */
export const LEGACY_VOLUME_KEY = "player_volume";

export type VolumePlayer = "native" | "youtube" | "twitch";

/** Each player's own device-local key. */
export function volumeKeyFor(p: VolumePlayer): string {
  return `player_volume_${p}`;
}

/** @test-only restorableVolume/levelToApplyAtReady in this file apply it; the test pins the value
 *  Below this a saved or reported level is treated as no level at all. A judgement call, to be
 *  re-derived from telemetry once there is data. Never used to clamp UP — 5% on a phone is
 *  still silence. */
export const MIN_RESTORE_VOLUME = 0.05;

/** @test-only levelToApplyAtReady in this file applies it; the test pins the value
 *  What a player starts at when it has no level of its own (the element and both embeds: full). */
export const DEFAULT_VOLUME = 1;

/** Clamp to the element's valid range. */
export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * @test-only restorableVolume in this file is the production caller; the test pins the parse alone
 * A persisted value, or null when it is absent/corrupt and the caller should
 * keep its default. Returns null rather than 0 deliberately — a failed parse
 * must not silently mute a new viewer.
 */
export function parseSavedVolume(raw: string | null): number | null {
  const n = parseFloat(raw ?? "");
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

/** Is the viewer hearing nothing? Either source of silence counts. */
export function isSilent(muted: boolean, volume: number): boolean {
  return muted || volume === 0;
}

/** What the slider renders — 0 whenever silent, so it never contradicts the audio. */
export function sliderPercent(muted: boolean, volume: number): number {
  return isSilent(muted, volume) ? 0 : Math.round(volume * 100);
}

/**
 * The level to restore when unmuting. Falls back to the last audible level, then
 * to full — never to 0, which would make the unmute button a no-op.
 */
export function unmuteVolume(volume: number, lastAudible: number): number {
  if (volume > 0) return volume;
  return clampVolume(lastAudible) || 1;
}

/** A saved level worth restoring, or null (absent, corrupt, or below the floor). */
export function restorableVolume(raw: string | null): number | null {
  const v = parseSavedVolume(raw);
  return v !== null && v >= MIN_RESTORE_VOLUME ? v : null;
}

/**
 * Should an adapter persist what its iframe reports? Only a level the viewer evidently set: read
 * after `ready`, unmuted, at or above the floor, and more than 0.01 away from the level applied
 * (or found) at `ready`. A phone embed has no slider, so it never qualifies — which is the point.
 */
export function shouldPersistAdapterRead(
  read: { volume: number; muted: boolean } | null,
  appliedAtReady: number | null,
): boolean {
  if (!read || read.muted || appliedAtReady === null) return false;
  if (!Number.isFinite(read.volume) || read.volume < MIN_RESTORE_VOLUME || read.volume > 1) return false;
  return Math.abs(read.volume - appliedAtReady) > 0.01;
}

/**
 * The level to set on an adapter at `ready`, or null to leave the embed as it is. Our saved level
 * wins. With none, an embed reporting a level below the floor — or nothing readable — is repaired
 * to DEFAULT_VOLUME; an embed already at a sane level of its own is left alone (most likely the
 * viewer set it there). Level only: this never unmutes (rule 1).
 */
export function levelToApplyAtReady(
  saved: number | null,
  embedRead: { volume: number; muted: boolean } | null,
): number | null {
  if (saved !== null) return saved;
  const v = embedRead?.volume;
  if (typeof v !== "number" || !Number.isFinite(v) || v < MIN_RESTORE_VOLUME) return DEFAULT_VOLUME;
  return null;
}

/**
 * One-time move off the shared key, run on every player mount (idempotent). An audible legacy
 * level becomes the IN-HOUSE player's level, only if that player has none yet; it is never copied
 * to YouTube/Twitch — the old value may be exactly the poison. The legacy key is removed in every
 * branch, so a stale pre-deploy tab that writes it again is simply migrated again next mount.
 */
export function migrateLegacyVolume(
  get: (k: string) => string | null,
  set: (k: string, v: string) => void,
  remove: (k: string) => void,
): void {
  const raw = get(LEGACY_VOLUME_KEY);
  if (raw === null) return;
  const v = restorableVolume(raw);
  const own = volumeKeyFor("native");
  if (v !== null && get(own) === null) set(own, String(v));
  remove(LEGACY_VOLUME_KEY);
}
