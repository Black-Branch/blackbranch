// The page half of the picture cache (#244): the viewer's four switches (Settings › Site & bars ›
// Storage on this device) sent to the service worker, which keeps them (public/sw.js), plus the
// size readout and "Clear cached pictures". Device-only: the switches are read UNSCOPED, because
// one worker serves every page of the origin, the OBS overlay included.
import { DEFAULTS, ENTRIES, type SettingKey } from "./settingsRegistry";
import { lsGet, lsRemove } from "./safeLocalStorage";

export type PicturePolicy = { on: boolean; emotes: boolean; avatars: boolean; previews: boolean };

const POLICY_KEYS = {
  on: "pictureCache",
  emotes: "pictureCacheEmotes",
  avatars: "pictureCacheAvatars",
  previews: "pictureCachePreviews",
} as const satisfies Record<keyof PicturePolicy, SettingKey>;

/** The caches the worker fills — the same names as public/sw.js.
 *  @test-only exported so pictureCache.test.ts holds them equal to the worker's; this module is its caller. */
export const PICTURE_CACHES = ["emote-cache-v3", "avatar-cache-v1", "preview-cache-v1"] as const;

/** The emote warm's "done" record (emoteWarmer.ts): forgotten with the pictures, or a refilled
 *  cache would never be warmed again. */
export const WARM_RECORD_KEY = "emoteWarm_v1";

/** Pure: the policy from stored values (absent = the default, which is on). */
export function readPicturePolicy(get: (ls: string) => string | null = lsGet): PicturePolicy {
  const on = (k: SettingKey) => {
    const v = ENTRIES[k].parse(get(ENTRIES[k].ls));
    return (v === null ? DEFAULTS[k] : v) === true;
  };
  return { on: on(POLICY_KEYS.on), emotes: on(POLICY_KEYS.emotes), avatars: on(POLICY_KEYS.avatars), previews: on(POLICY_KEYS.previews) };
}

/** Pure: whether emote and sticker pictures are kept (the warm runs only then). */
export function emoteCacheOn(p: PicturePolicy): boolean {
  return p.on && p.emotes;
}

const POLICY_LS = new Set<string>(Object.values(POLICY_KEYS).map((k) => ENTRIES[k].ls));

function post(message: unknown): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage(message)).catch(() => {});
}

function sendPolicy(): void {
  const policy = readPicturePolicy();
  if (!emoteCacheOn(policy)) lsRemove(WARM_RECORD_KEY);
  post({ type: "bb:picture-cache", policy });
  if (policy.on) keepStorage();
}

// Ask the browser not to evict the site's storage under pressure. Chromium answers silently;
// Firefox would put a permission prompt in front of every viewer, so it is not asked there.
let askedToKeep = false;
function keepStorage(): void {
  if (askedToKeep || typeof navigator === "undefined") return;
  askedToKeep = true;
  const nav = navigator as Navigator & { userAgentData?: unknown };
  if (!nav.userAgentData || !navigator.storage?.persist) return;
  navigator.storage.persisted().then((done) => (done ? true : navigator.storage.persist())).catch(() => {});
}

let started = false;
/** Send the switches to the worker now and whenever one changes. Called once, after registration. */
export function startPictureCache(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  sendPolicy();
  window.addEventListener("bb:setting", (e) => {
    const key = (e as CustomEvent).detail;
    if (typeof key === "string" && POLICY_LS.has(key)) sendPolicy();
  });
}

/** Bytes the picture caches hold on this device (0 when Cache Storage is unavailable). */
export async function pictureCacheBytes(): Promise<number> {
  if (typeof caches === "undefined") return 0;
  let total = 0;
  for (const name of PICTURE_CACHES) {
    if (!(await caches.has(name))) continue;
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (!res) continue;
      const len = Number(res.headers.get("content-length"));
      total += Number.isFinite(len) && len > 0 ? len : (await res.blob()).size;
    }
  }
  return total;
}

/** Empty every picture cache. The worker is told too, so its in-memory indexes start over. */
export async function clearPictureCache(): Promise<void> {
  lsRemove(WARM_RECORD_KEY);
  post({ type: "bb:picture-cache-clear" });
  if (typeof caches === "undefined") return;
  await Promise.all(PICTURE_CACHES.map((n) => caches.delete(n)));
}

/** Pure: "12.3 MB" / "840 KB" / "0 KB". */
export function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(n / 1000)} KB`;
}
