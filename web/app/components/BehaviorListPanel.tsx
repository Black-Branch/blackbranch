"use client";
// The two account-list editors in Behavior:
//   People — everyone you have hidden, × to unhide, + to hide someone by name.
//   Words  — words/phrases that highlight a message (and play the mention sound).
// Both lists follow the account to every device (behaviorStore.ts).
import { useState } from "react";
import { X, Plus } from "@phosphor-icons/react/dist/ssr";
import { useBehaviorLists, hidePerson, unhidePerson, setHighlightWords, type HideResult } from "@/app/lib/behaviorStore";
import { MAX_WORDS, MAX_WORD_LEN } from "@/app/lib/behaviorLists";
import { resolveChatter } from "@/app/lib/hideTarget";
import { liveDirectory, liveViewer } from "@/app/lib/liveDirectory";
import { useMatrixIdentity } from "@/app/lib/MatrixClientContext";
import { FIELD } from "./SettingsControls";

/** What the + field says for each outcome (nothing = it worked). */
const HIDE_NOTE: Partial<Record<HideResult, string>> = {
  self: "That\u2019s you.",
  already: "Already hidden.",
  full: "That\u2019s the most people you can hide.",
  failed: "Couldn\u2019t save — try again.",
};

const ICON_BTN = "h-6 w-6 shrink-0 inline-flex items-center justify-center rounded-md text-secondary hover:text-body hover:bg-control disabled:opacity-40";

function Chip({ label, onRemove, removeLabel }: { label: string; onRemove: () => void; removeLabel: string }) {
  return (
    <li className="flex items-center gap-2 min-h-7 pl-2 rounded-md bg-surface-1">
      <span className="flex-1 min-w-0 truncate text-xs text-body" title={label}>{label}</span>
      <button type="button" className={ICON_BTN} onClick={onRemove} aria-label={removeLabel} title={removeLabel}>
        <X size={12} weight="bold" />
      </button>
    </li>
  );
}

function AddField({ placeholder, onAdd, maxLength }: { placeholder: string; onAdd: (v: string) => Promise<string | null>; maxLength?: number }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const submit = async () => {
    if (!text.trim()) return;
    const err = await onAdd(text);
    setNote(err);
    if (!err) setText("");
  };
  return (
    <div>
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input
          value={text}
          maxLength={maxLength}
          onChange={(e) => { setText(e.target.value); setNote(null); }}
          placeholder={placeholder}
          aria-label={placeholder}
          className={`${FIELD} flex-1 min-w-0 px-2 text-xs`}
        />
        <button type="submit" className={ICON_BTN} aria-label="Add" title="Add" disabled={!text.trim()}>
          <Plus size={14} weight="bold" />
        </button>
      </form>
      {note && <p className="mt-1 text-2xs text-secondary">{note}</p>}
    </div>
  );
}

function PeoplePanel() {
  const lists = useBehaviorLists();
  const { matrixId } = useMatrixIdentity();
  return (
    <div className="space-y-1 pt-1">
      {lists.hidden.length === 0
        ? <p className="text-2xs text-secondary">No one hidden. Hide someone from their name card, with /ignore name, or here.</p>
        : <ul className="space-y-1">{lists.hidden.map((h) => (
            <Chip key={h.id} label={h.name} removeLabel={`Show ${h.name} again`} onRemove={() => { void unhidePerson(h.id); }} />
          ))}</ul>}
      <AddField
        placeholder="Hide someone in chat…"
        onAdd={async (v) => {
          const who = resolveChatter(liveDirectory(), v);
          if (!who) return "No one by that name has spoken in chat yet.";
          const r = await hidePerson(who, { matrixId, ownIds: liveViewer().ownIds });
          return HIDE_NOTE[r] ?? null;
        }}
      />
    </div>
  );
}

function WordsPanel() {
  const lists = useBehaviorLists();
  return (
    <div className="space-y-1 pt-1">
      {lists.words.length === 0
        ? <p className="text-2xs text-secondary">Messages with one of these words get highlighted, like a mention.</p>
        : <ul className="space-y-1">{lists.words.map((w) => (
            <Chip key={w} label={w} removeLabel={`Remove ${w}`} onRemove={() => { void setHighlightWords((cur) => cur.filter((x) => x !== w)); }} />
          ))}</ul>}
      {lists.words.length < MAX_WORDS
        ? <AddField placeholder="Add a word…" maxLength={MAX_WORD_LEN} onAdd={async (v) => (await setHighlightWords((cur) => [...cur, v])) ? null : "Couldn\u2019t save — try again."} />
        : <p className="text-2xs text-secondary">That&rsquo;s the most ({MAX_WORDS}).</p>}
    </div>
  );
}

export default function BehaviorListPanel({ kind }: { kind: "people" | "words" }) {
  return kind === "people" ? <PeoplePanel /> : <WordsPanel />;
}
