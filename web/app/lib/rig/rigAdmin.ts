// The OBS page's rig panel, server side: stream-api's /rig/* routes (stream-api/rig.js) read and
// driven for an admin. SERVER ONLY — the status carries the page key.

import { installValue } from "../installValues";
import { streamApiFetch } from "../streamApi";

export type RigPage = { since: string; level: number | null; scene: string | null };
export type RigView = {
  /** The obs module is on and stream-api answers its rig routes. */
  on: boolean;
  /** Why the status could not be read (off, unreachable) — null when it was. */
  error: string | null;
  connected: number;
  pages: RigPage[];
  scenes: string[];
  scene: string | null;
  speaking: boolean;
  /** Where sounds and the voice go now: the audio satellite, the rig page, or this server. */
  sink: "satellite" | "rig" | "local" | null;
  /** The browser source's address, with this install's key. */
  url: string | null;
};

const EMPTY: Omit<RigView, "on" | "error"> = { connected: 0, pages: [], scenes: [], scene: null, speaking: false, sink: null, url: null };

/** The browser source's address for this site and key. Pure. */
function rigPageUrl(origin: string, key: string): string {
  return `${origin.replace(/\/+$/, "")}/overlay/rig?key=${encodeURIComponent(key)}`;
}

export async function rigStatus(): Promise<RigView> {
  let res: Response;
  try { res = await streamApiFetch("/rig/status", { cache: "no-store" }); } catch { return { on: false, error: "the chat service did not answer", ...EMPTY }; }
  // The obs module's routes are mounted only while it is on (stream-api modules.js).
  if (res.status === 404) return { on: false, error: null, ...EMPTY };
  if (!res.ok) return { on: false, error: `the chat service answered ${res.status}`, ...EMPTY };
  const s = (await res.json().catch(() => null)) as (Omit<RigView, "url" | "error"> & { key?: string | null }) | null;
  if (!s) return { on: false, error: "the chat service answered nonsense", ...EMPTY };
  return {
    on: s.on === true, error: null,
    connected: Number(s.connected) || 0,
    pages: Array.isArray(s.pages) ? s.pages : [],
    scenes: Array.isArray(s.scenes) ? s.scenes.filter((x): x is string => typeof x === "string") : [],
    scene: typeof s.scene === "string" ? s.scene : null,
    speaking: s.speaking === true,
    sink: s.sink === "satellite" || s.sink === "rig" || s.sink === "local" ? s.sink : null,
    url: typeof s.key === "string" && s.key ? rigPageUrl(installValue("site.origin"), s.key) : null,
  };
}

/** One of the panel's actions, forwarded to stream-api. */
export async function rigAction(body: { action?: unknown; name?: unknown; what?: unknown }, adminId: string): Promise<{ status: number; body: unknown }> {
  const post = async (path: string, payload: unknown) => {
    try {
      const res = await streamApiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      return { status: res.status === 404 ? 409 : res.status, body: res.status === 404 ? { error: "the OBS module is off" } : await res.json().catch(() => ({})) };
    } catch {
      return { status: 502, body: { error: "the chat service did not answer" } };
    }
  };
  if (body.action === "regenerate") return post("/rig/key", { updatedBy: adminId });
  if (body.action === "scene" && typeof body.name === "string") return post("/rig/scene", { name: body.name });
  if (body.action === "test" && (body.what === "voice" || body.what === "sound")) return post("/rig/test", { what: body.what });
  return { status: 400, body: { error: "unknown action" } };
}
