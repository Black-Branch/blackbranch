"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { normalizeHex } from "../lib/colors";

// Controls + text standard (the written standard is docs/DESIGN-STANDARD.md).
// Every settings-style control shares these: one field style, 24px
// controls in rows of at least 28px, a 112px label column that truncates
// instead of wrapping, and one readout box with the unit inside it.
// "Selected" is always light fill + dark content — the same rule as the
// selected preset, never a mid-grey that reads like "off".
export const FIELD = "h-6 rounded-md bg-surface-2 border border-edge text-body outline-none focus:ring-1 focus:ring-edge-bright";
const ROW = "flex items-center min-h-7";
const LABEL = "w-28 shrink-0 truncate text-xs text-body-dim";
const READOUT = "w-16 h-6 shrink-0 flex items-center justify-end gap-0.5 px-1.5 rounded-md bg-surface-2 border border-edge text-xs tabular-nums";

export function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  const editing = useRef(false);
  // Sync from the live value only while not actively editing, so 3→6 hex
  // expansion never clobbers what the user is mid-typing (typing #1a2b3c would
  // otherwise get rewritten to #11aa22 the moment #1a2 is a valid shorthand).
  useEffect(() => { if (!editing.current) setText(value); }, [value]);
  const normalized = normalizeHex(text);
  const commit = () => {
    editing.current = false;
    const n = normalizeHex(text);
    if (n) { setText(n); onChange(n); }
    else setText(value);
  };
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        value={normalized ?? value}
        onChange={e => { setText(e.target.value); onChange(e.target.value); }}
        className="ui-color w-6 h-6 shrink-0 cursor-pointer p-0 bg-transparent rounded-md border border-edge"
      />
      <input
        type="text"
        value={text}
        onFocus={() => { editing.current = true; }}
        onChange={e => {
          const v = e.target.value;
          setText(v);
          // Live-preview only when the raw entry is already a full 6-digit hex.
          // 3-digit shorthand is left as typed and expanded on Enter/blur, so
          // typing a longer value (#1a2b3c) isn't interrupted at #1a2.
          const s = v.trim().replace(/^#/, "");
          if (/^[0-9a-fA-F]{6}$/.test(s)) onChange("#" + s);
        }}
        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        onBlur={commit}
        maxLength={7}
        className={`${FIELD} w-[5.5rem] px-1.5 text-2xs font-mono`}
      />
    </div>
  );
}

// A typeable readout for a slider: shows the live value but lets the user type an
// exact one. Commits on Enter/blur; reverts to the live value if the entry is
// blank/invalid. `unit` is the trailing label shown after the field (e.g. "rem").
function EditableNum({ value, unit, label, onCommit }: {
  value: number; unit?: string; label: string; onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const editing = useRef(false);
  // Track the live value while not actively editing.
  useEffect(() => { if (!editing.current) setText(String(value)); }, [value]);
  const commit = () => {
    editing.current = false;
    const n = parseFloat(text);
    if (Number.isFinite(n)) onCommit(n);
    else setText(String(value));
  };
  // The unit sits INSIDE the box (decision 4): one fixed width for every
  // slider, so every track ends at the same x.
  return (
    <label className={READOUT + " text-body focus-within:ring-1 focus-within:ring-edge-bright"}>
      <input
        type="text" inputMode="decimal" value={text}
        aria-label={`${label} value`}
        onFocus={() => { editing.current = true; }}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
        className="w-full min-w-0 bg-transparent text-right outline-none"
      />
      {unit && <span className="text-3xs text-muted shrink-0">{unit}</span>}
    </label>
  );
}

export function Slider({ label, min, max, step = 1, value, onChange, display, title, edit }: {
  label: string; min: number; max: number; step?: number;
  value: number; onChange: (v: number) => void; display: string;
  // Tooltip for a word readout ("Auto") that needs its meaning spelled out.
  title?: string;
  // When provided, the readout becomes a typeable field. When omitted, it's
  // auto-derived from `display` so EVERY slider is typeable (see `auto`). Only
  // sliders with a non-linear raw↔display mapping (text size) pass an explicit edit.
  edit?: { value: number; unit?: string; onCommit: (n: number) => void };
}) {
  const auto = useMemo(() => {
    if (edit) return null;
    const m = /^\s*(-?\d*\.?\d+)\s*(.*?)\s*$/.exec(display);
    if (!m) return null;
    const dispNum = parseFloat(m[1] ?? "");
    const unit = m[2] || undefined;
    const ratio = value !== 0 ? dispNum / value : NaN;
    const scale = Number.isFinite(ratio) && ratio !== 0 ? ratio : 1; // display units per raw unit
    return {
      value: dispNum,
      unit,
      onCommit: (n: number) => {
        const raw = Math.round(n / scale);
        onChange(Math.min(max, Math.max(min, raw)));
      },
    };
  }, [edit, display, value, min, max, onChange]);
  const eff = edit ?? auto;
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className={`${ROW} gap-2`}>
      <span className={LABEL} title={label}>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        // The visible span is not the input's name — the same rule as the
        // Toggle below (namedControls.test.ts).
        aria-label={label}
        className="ui-range flex-1 min-w-0"
        // The filled part of the track (.ui-range in globals.css) — WebKit has
        // no progress pseudo-element, so the fill is a gradient stop.
        style={{ "--fill": `${fill}%` } as React.CSSProperties}
      />
      {eff
        ? <EditableNum value={eff.value} unit={eff.unit} label={label} onCommit={eff.onCommit} />
        : <span className={`${READOUT} text-secondary`} title={title ?? display}>
            <span className="truncate">{display}</span>
          </span>}
    </div>
  );
}

// `label` supplies the accessible name — a bare <button> with a decorative
// span is invisible to screen readers. role="switch" + aria-checked announce
// it as an on/off control and read its current state; the visible <Row> label
// stays as-is since the switch names itself.
export function Toggle({ on, onToggle, label, disabled }: { on: boolean; onToggle: () => void; label?: string; disabled?: boolean }) {
  // On = light track + dark knob, off = dark track + light knob (decision 1):
  // the two states differ in brightness, not just in knob position.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      disabled={disabled}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-edge-bright disabled:opacity-50 ${on ? "bg-strong" : "bg-control"}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full shadow-sm transition-transform ${on ? "translate-x-4 bg-on-accent" : "bg-strong"}`} />
    </button>
  );
}

// One segmented track for every pick-one row (decision 6): the options sit in a
// rounded track, the chosen one takes the light fill. It wraps inside its track
// only when the options do not fit on one line (a phone-width panel).
export function Choice<V extends string | number>({ label, options, value, onChange }: {
  label: string;
  options: readonly { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <div role="group" aria-label={label} className="min-w-0 flex flex-wrap justify-end gap-0.5 p-0.5 rounded-md bg-surface-2">
      {options.map(o => {
        const selected = value === o.value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(o.value)}
            className={`h-5 px-2 rounded text-xs transition-colors outline-none focus-visible:ring-1 focus-visible:ring-edge-bright ${
              selected ? "bg-strong text-on-accent font-medium" : "text-body-dim hover:bg-surface-3 hover:text-body"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Spacing standard (decision 11): title → first row 6px, row → row 4px. The
// 16px between sections is the caller's stack.
export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-2xs text-secondary uppercase tracking-wide font-semibold">{title}</p>
      {hint && <p className="-mt-0.5 mb-1.5 text-2xs text-muted">{hint}</p>}
      <div className="space-y-1">{children}</div>
    </div>
  );
}

// `wide`: the control fills the row (font picker), so the label takes the same
// 112px column as a slider's and the two line up.
export function Row({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={`${ROW} justify-between gap-2`}>
      <span className={wide ? LABEL : "min-w-0 max-w-1/2 shrink-0 truncate text-xs text-body-dim"} title={label}>{label}</span>
      {children}
    </div>
  );
}
