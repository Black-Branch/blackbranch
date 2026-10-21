// The Leaderboard's face table: what each face is called, which
// windows it offers, how its value prints. Pure and client-safe — the widget
// and the rank route both read it; the SQL lives in boards.ts (server-only).
import type { EquippedStyle } from "./usernameStyles.ts";
import { currencyName, scoreName, scoreShortName } from "./currency.ts";

export type FaceId =
  | "points" | "credit" | "creditRate" | "streams"
  | "wholesome" | "toxic" | "bigBrain" | "smallBrain"
  | "messages" | "emotes";
export type WindowId = "stream" | "week" | "month" | "all";

export type BoardRow = {
  /** A person: their matrix id, or `c:<canonical>` when unlinked. A message: `<platform>:<id>`. An emote: its name. */
  key: string;
  rank: number;
  name: string;
  color: string | null;
  style: EquippedStyle | null;
  avatarUrl: string | null;
  value: number;
  /** Top messages: the message and its own emote map. */
  text?: string;
  emotes?: Record<string, string> | null;
  /** Top emotes: the picture. */
  emoteUrl?: string;
};

/** The public part of the Home body: the top five of every face × window.
 *  A window is `null` while its cache is still warming (the boards never hold
 *  the Home body); the widget says Loading… for it. */
export type HomeBoards = Record<FaceId, Record<WindowId, BoardRow[] | null>>;

/** Every window present. A body built while any is cold is served but not
 *  remembered (homeCache); no boards at all is nothing to wait for. */
export function boardsWarm(b: HomeBoards | null): boolean {
  if (b === null) return true;
  return FACES.every((f) => f.windows.every((w) => b[f.id]?.[w] !== null && b[f.id]?.[w] !== undefined));
}

export type FaceDef = {
  id: FaceId;
  label: string;
  /** Rows are people (the You row applies) — false for messages and emotes. */
  people: boolean;
  /** Which windows the face offers, in pill order. */
  windows: readonly WindowId[];
  /** How the value prints. */
  format: (v: number) => string;
};

export const WINDOW_IDS: readonly WindowId[] = ["stream", "week", "month", "all"];
const NO_STREAM: readonly WindowId[] = ["week", "month", "all"];

const int = (v: number) => String(Math.round(v));
const signed = (v: number) => (v > 0 ? `+${Math.round(v)}` : String(Math.round(v)));
const signedTenth = (v: number) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
const pct = (v: number) => `${Math.round(v)}%`;

// The chip order. Most messages, longest streak, most replied to, the bot's
// favourite and most polls are deliberately not faces.
export const FACES: readonly FaceDef[] = [
  { id: "points", label: `Earned ${currencyName()}`, people: true, windows: WINDOW_IDS, format: int },
  { id: "credit", label: scoreName(), people: true, windows: WINDOW_IDS, format: signed },
  { id: "creditRate", label: `${scoreShortName()} / 100`, people: true, windows: WINDOW_IDS, format: signedTenth },
  { id: "streams", label: "Streams", people: true, windows: NO_STREAM, format: int },
  { id: "wholesome", label: "Wholesome", people: true, windows: WINDOW_IDS, format: pct },
  { id: "toxic", label: "Toxic", people: true, windows: WINDOW_IDS, format: pct },
  { id: "bigBrain", label: "Big brain", people: true, windows: WINDOW_IDS, format: pct },
  { id: "smallBrain", label: "Small brain", people: true, windows: WINDOW_IDS, format: pct },
  { id: "messages", label: "Top messages", people: false, windows: WINDOW_IDS, format: signed },
  { id: "emotes", label: "Top emotes", people: false, windows: WINDOW_IDS, format: int },
];

export const FACE_IDS: readonly FaceId[] = FACES.map((f) => f.id);

const byId = new Map(FACES.map((f) => [f.id, f] as const));
const def = (face: FaceId): FaceDef => byId.get(face)!;

/** A face id as stored or sent; null when it is not a face. */
export function faceIdOf(id: string | null): FaceId | null {
  if (id === null) return null;
  return byId.has(id as FaceId) ? (id as FaceId) : null;
}

/** A stored face id that no longer exists (or never did) falls to the vote score. */
export function faceOrDefault(id: string | null): FaceId {
  return faceIdOf(id) ?? "credit";
}
export function isWindowId(w: string | null): w is WindowId {
  return w !== null && (WINDOW_IDS as readonly string[]).includes(w);
}
export function windowsFor(face: FaceId): readonly WindowId[] { return def(face).windows; }
/** Stream while live, Week offline. */
export function defaultWindow(live: boolean): WindowId { return live ? "stream" : "week"; }
export function formatValue(face: FaceId, v: number): string { return def(face).format(v); }
export function isPeopleFace(face: FaceId): boolean { return def(face).people; }
export function faceLabel(face: FaceId): string { return def(face).label; }
/** The rate boards' floor in scored messages: one stream scores too few for 20
 *  (it would leave a handful of people on a board), so Stream asks for 5. */
export function floorFor(w: WindowId): number { return w === "stream" ? 5 : 20; }
export function windowLabel(w: WindowId): string {
  return w === "stream" ? "Stream" : w === "week" ? "Week" : w === "month" ? "Month" : "All";
}
