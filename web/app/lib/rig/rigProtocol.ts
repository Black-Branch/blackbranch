// The rig page's socket protocol, page side. stream-api/rig.js is the server side and its header
// lists the same frames; rigProtocol.test.ts reads that file and holds the two lists equal. These
// frames travel only on wss://<api>/rig — never on the public broadcast socket (wsFrames.ts is that
// socket's registry).

/** Frames the server sends to a rig page.
 *  @test-only rigProtocol.test.ts holds this list equal to stream-api/rig.js's; the page itself
 *  narrows frames through parseRigFrame. */
export const RIG_SERVER_FRAMES = ["rig.welcome", "rig.play", "rig.stop", "rig.speaking", "rig.setScene"] as const;
/** Frames a rig page sends to the server.
 *  @test-only rigProtocol.test.ts holds this list equal to what stream-api/rig.js reads and to
 *  what RigOverlay.tsx sends. */
export const RIG_PAGE_FRAMES = ["rig.hello", "rig.started", "rig.ended", "rig.scene"] as const;

export type RigServerFrame =
  | { type: "rig.welcome"; speaking: boolean }
  | { type: "rig.play"; id: string; url: string; kind: "tts" | "sound" }
  | { type: "rig.stop"; id: string }
  | { type: "rig.speaking"; on: boolean }
  | { type: "rig.setScene"; name: string };

/** obsstudio.getControlLevel(): 4 = "Advanced access to OBS", the level setCurrentScene needs. */
export const OBS_LEVEL_ADVANCED = 4;
/** 2 = "Read access to user information": getCurrentScene / getScenes. */
export const OBS_LEVEL_READ_USER = 2;

/** The subprotocols a rig page offers: the protocol name, and the key — checked by the server at
 *  the upgrade, before a socket exists (stream-api/rig.js handleUpgrade). The server answers with
 *  the name only. */
export function rigProtocols(key: string): string[] {
  return ["rig.v1", `rig-key.${key}`];
}

/** The rig socket's address on the api's WebSocket origin. */
export function rigSocketUrl(wsOrigin: string): string {
  return `${wsOrigin.replace(/\/+$/, "")}/rig`;
}

/** A frame from the server, checked; null for anything else. Pure. */
export function parseRigFrame(raw: unknown): RigServerFrame | null {
  let v: unknown;
  try { v = typeof raw === "string" ? JSON.parse(raw) : null; } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  const id = typeof f.id === "string" && /^[0-9a-f]{32}$/.test(f.id) ? f.id : null;
  switch (f.type) {
    case "rig.welcome": return { type: "rig.welcome", speaking: f.speaking === true };
    case "rig.speaking": return { type: "rig.speaking", on: f.on === true };
    case "rig.stop": return id ? { type: "rig.stop", id } : null;
    case "rig.setScene": return typeof f.name === "string" && f.name ? { type: "rig.setScene", name: f.name } : null;
    case "rig.play":
      // Only a clip path on the api's own origin: the page never fetches an address the frame names.
      return id && typeof f.url === "string" && f.url.startsWith(`/rig/clip/${id}?`)
        ? { type: "rig.play", id, url: f.url, kind: f.kind === "tts" ? "tts" : "sound" } : null;
    default: return null;
  }
}
