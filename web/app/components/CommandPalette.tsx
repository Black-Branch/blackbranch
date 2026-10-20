"use client";

import { useEffect, useRef } from "react";
import type { Parsed, Suggestion } from "@/app/lib/commands/parse";
import { hintLine, currentArg } from "@/app/lib/commands/parse";

// The `/` command overlay.
//
// Replaces CommandHints, which prefix-matched the first word only, was
// mouse-only (no keyboard at all), and whose onPick replaced the WHOLE input —
// so touching a suggestion while `/ban someuser` was typed destroyed the
// argument. Selection and insertion are token-scoped here; see parse.ts.
//
// It also carries a persistent signature line, so the arguments a command takes
// are visible while you type them rather than only in a list you have dismissed.

export function CommandPalette({
  parsed, suggestions, selected, onSelect, onPick,
}: {
  parsed: Parsed;
  suggestions: Suggestion[];
  selected: number;
  onSelect: (i: number) => void;
  onPick: (s: Suggestion) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const sig = hintLine(parsed);
  const arg = currentArg(parsed);

  // Keep the keyboard selection scrolled into view.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (suggestions.length === 0 && !sig) return null;

  return (
    <div className="absolute bottom-full left-2 right-2 mb-1 glass rounded overflow-hidden text-xs z-50">
      {suggestions.length > 0 && (
        // One consumer (ChatInput), so the id can be fixed — unlike
        // EmoteCompletionList's, which is a prop because it mounts thrice.
        <div ref={listRef} id="command-palette-list" role="listbox" className="max-h-56 overflow-y-auto overscroll-contain">
          {suggestions.map((s, i) => (
            <button
              key={`${s.kind}:${s.value}`}
              data-i={i}
              type="button"
              role="option"
              id={`command-palette-list-opt-${i}`}
              aria-selected={i === selected}
              // onMouseDown, not onClick: the textarea must not lose focus before
              // the value is applied, or the caret position is gone.
              onMouseDown={(e) => { e.preventDefault(); onPick(s); }}
              onMouseEnter={() => onSelect(i)}
              className={`w-full text-left px-3 py-1.5 flex gap-2 items-baseline transition-colors ${
                i === selected ? "bg-surface-3" : "hover:bg-surface-2"
              }`}
            >
              <span className={`font-mono font-semibold shrink-0 ${
                s.kind === "user" ? "text-sky-300" : "text-strong"
              }`}>
                {s.kind === "user" ? `@${s.label}` : s.label}
              </span>
              {s.desc && <span className="text-muted truncate ml-auto">{s.desc}</span>}
            </button>
          ))}
        </div>
      )}
      {sig && (
        <div className="px-3 py-1 border-t border-edge bg-surface-1/60 font-mono text-3xs text-muted flex gap-2">
          <span className="text-body-dim">{sig}</span>
          {arg && <span className="ml-auto shrink-0">↑↓ pick · Tab/Enter complete · Esc dismiss</span>}
        </div>
      )}
    </div>
  );
}
