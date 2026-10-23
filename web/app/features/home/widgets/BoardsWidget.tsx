"use client";
import { useEffect, useMemo, useState } from "react";
import {
  faceOrDefault, faceLabel, windowsFor, windowLabel, defaultWindow, formatValue, isPeopleFace,
  type FaceId, type WindowId, type BoardRow, type HomeBoards,
} from "@/app/lib/boardFaces";
import { messageScores } from "@/app/lib/plugins/installed";
import { facesShown, faceShown } from "../boardFacesShown";
import { useLocalStorageString } from "@/app/lib/useClientState";
import { getJson } from "@/app/lib/http";
import { renderText } from "@/app/lib/renderText";
import { usernameStyleCSS, usernameStyleAnimClass } from "@/app/lib/usernameStyles";
import { useNameInk } from "@/app/lib/nameInk";
import { useAnimFenceRef } from "@/app/lib/animFence";
import { avatarBg } from "@/app/lib/avatarColor";
import { emoteCrossOrigin } from "@/app/lib/emoteRes";

// The Leaderboard: a list with face chips — the face name as the title, the
// window pills beside it, a chip per face (wrapping, so every face is
// reachable), ten rows, and — signed in — your own place. Face: remembered
// per device. Window: Stream while live, Week offline, a pick stands for the
// visit. The rows are pure over the payload; the You row is the one fetch
// (/api/home/rank), re-asked on every face/window change and on each 60 s
// body refresh (the `boards` object identity changes with the body).
type Rank = { rank: number; value: number; key: string };
const EMPTY_EMOTES = {};
const warmed = new Set<string>();
// The AI-score faces only where the install's plugin computes those scores (boardFacesShown.ts).
const FACES = facesShown(messageScores());

export function BoardsWidget({ boards, loading, live, signedIn, hidden }: {
  boards: HomeBoards | null;
  loading: boolean;
  live: boolean;
  signedIn: boolean;
  /** The boards switched off in the Admin Panel (leaderboard.hidden). */
  hidden?: readonly string[];
}) {
  const [storedFace, setStoredFace] = useLocalStorageString("home_board_face");
  const offered = useMemo(() => {
    const kept = FACES.filter((f) => !hidden?.includes(f.id));
    return kept.length ? kept : FACES;
  }, [hidden]);
  const pick = faceShown(faceOrDefault(storedFace), offered);
  // The vote score is faceShown's fallback; when that board is switched off too, the first one offered.
  const face: FaceId = offered.some((f) => f.id === pick) ? pick : offered[0]!.id;
  const [picked, setPicked] = useState<WindowId | null>(null);
  const wanted = picked ?? defaultWindow(live);
  // The Streams face offers no Stream window: a Stream pick carried onto it
  // falls to its first offered window (Week).
  const win: WindowId = windowsFor(face).includes(wanted) ? wanted : windowsFor(face)[0]!;
  // The answer is stored WITH the question it answered, so a face or window
  // change never shows the previous face's place while the new one loads —
  // and no setState runs in the effect body (react-hooks/set-state-in-effect).
  const [answer, setAnswer] = useState<{ face: FaceId; win: WindowId; rank: Rank | null } | null>(null);
  const askRank = signedIn && isPeopleFace(face);

  useEffect(() => {
    if (!askRank) return;
    let gone = false;
    getJson<Rank | null>(`/api/home/rank?face=${face}&window=${win}`)
      .then((r) => { if (!gone) setAnswer({ face, win, rank: r }); })
      .catch(() => { if (!gone) setAnswer({ face, win, rank: null }); });
    return () => { gone = true; };
  }, [askRank, face, win, boards]);

  const rank = askRank && answer && answer.face === face && answer.win === win ? answer.rank : null;
  const rows = boards?.[face]?.[win] ?? null;

  // Every picture on every face × window is warmed in the browser cache once
  // per body, so switching faces never shows a row loading its avatar.
  // The body itself already carries every list — no fetch.
  useEffect(() => {
    if (!boards) return;
    for (const lists of Object.values(boards)) for (const rows of Object.values(lists)) for (const r of rows ?? []) {
      const url = r.emoteUrl ?? r.avatarUrl;
      if (url && !warmed.has(url)) { warmed.add(url); new Image().src = url; }
    }
  }, [boards]);
  const highlightKey = rank && rank.rank <= 10 ? rank.key : null;

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <h2 className="text-sm font-semibold text-strong truncate">{faceLabel(face)}</h2>
        <div className="flex gap-0.5 shrink-0">
          {windowsFor(face).map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={w === win}
              onClick={() => setPicked(w)}
              className={`px-1.5 py-0.5 rounded-full text-2xs ${w === win ? "bg-surface-3 text-strong" : "text-muted hover:text-strong"}`}
            >
              {windowLabel(w)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {offered.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={f.id === face}
            onClick={() => setStoredFace(f.id)}
            className={`px-2 py-0.5 rounded-full text-2xs border border-edge shrink-0 ${f.id === face ? "bg-strong text-canvas" : "text-muted hover:text-strong"}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {rows === null
        // A body with a null window is one still warming on the server.
        ? <p>{loading || boards ? "Loading…" : "Couldn't load right now."}</p>
        : rows.length === 0
          ? <p className="text-muted">Nothing yet</p>
          : (
            <ul className="flex flex-col">
              {rows.map((r) => <Row key={r.key} face={face} r={r} highlight={r.key === highlightKey} />)}
              {rank && rank.rank > 10 && (
                <li className="flex items-center gap-2 pt-1 mt-1 border-t border-dashed border-edge text-muted">
                  <span className="w-5 text-right tabular-nums">{rank.rank}</span>
                  <span className="w-5 h-5 rounded-full bg-surface-3 shrink-0" />
                  <span className="flex-1">You</span>
                  <span className="tabular-nums">{formatValue(face, rank.value)}</span>
                </li>
              )}
            </ul>
          )}
    </div>
  );
}

function Row({ face, r, highlight }: { face: FaceId; r: BoardRow; highlight: boolean }) {
  // The name wears the person's chat colour and equipped style, as the pinned
  // banner does (the colour is data, applied inline — never a literal here).
  const nameInkRef = useNameInk(r.style?.font, r.name);
  // An animated name below the fold pauses until it is scrolled to (the board would otherwise
  // run name glows nobody can see). Same look the moment it is on screen.
  const animClass = usernameStyleAnimClass(r.style);
  const nameRef = useAnimFenceRef(animClass !== "", nameInkRef);
  const name = (
    <span ref={nameRef} className={animClass} style={{ color: r.color ?? undefined, ...usernameStyleCSS(r.style, r.color) }}>
      {r.name}
    </span>
  );
  return (
    <li className={`flex items-center gap-2 py-0.5 min-w-0 ${highlight ? "bg-surface-3 -mx-1 px-1 rounded" : ""}`}>
      <span className="w-5 text-right tabular-nums text-muted">{r.rank}</span>
      {face === "emotes"
        ? <img src={r.emoteUrl} crossOrigin={emoteCrossOrigin(r.emoteUrl ?? "")} alt={r.name} className="w-6 h-6 shrink-0 object-contain" />
        : r.avatarUrl
          ? <img src={r.avatarUrl} alt="" className="w-5 h-5 rounded-full shrink-0 object-cover" />
          : <span className="w-5 h-5 rounded-full shrink-0 text-2xs font-semibold text-strong flex items-center justify-center" style={{ backgroundColor: avatarBg(r.name) }} aria-hidden="true">{r.name.slice(0, 1)}</span>}
      {face === "messages"
        // The whole message, wrapped under the name — a cut-off line is not
        // readable.
        ? (
          <span className="flex-1 min-w-0 flex flex-col">
            <span className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate py-1 -my-1">{name}</span>
              <span className="tabular-nums text-strong shrink-0">{formatValue(face, r.value)}</span>
            </span>
            <span className="text-secondary whitespace-pre-wrap break-words">{renderText(r.text ?? "", EMPTY_EMOTES, r.emotes)}</span>
          </span>
        )
        : (
          <>
            <span className="flex-1 min-w-0 truncate py-1 -my-1">{name}</span>
            <span className="tabular-nums text-strong shrink-0">{formatValue(face, r.value)}</span>
          </>
        )}
    </li>
  );
}
