"use client";

// Admin Panel › Site › Community › Roles: the ladder, top down, each rung with what it can do
// (spec 2026-10-23 §4.2). A role's name, colour and whether it is its own group in the member list
// are the streamer's; its level and key are fixed (the route refuses a level change). A save goes
// through the page's one save: the database first, then the host. The member list reads the new
// names and colours through its own ladder fetch.

import { useState } from "react";
import type { RoleRow } from "@/app/lib/community/desired";
import { ColorInput, Toggle } from "@/app/components/SettingsControls";
import type { Save } from "./ChannelsPage";
import { btn, card, chip, h2, input } from "./parts";

/** What each built-in rung can do, in plain words. */
const CAN: Record<string, string> = {
  admin: "Everything.",
  staff: "Moderate and edit channels. Not roles, who can see, how long messages are kept, or encryption.",
  mod: "Remove, ban and time out people, delete messages, pin, and mention everyone.",
  bot: "The same as Mod, listed with the bots.",
  supporter: "Post where a channel says Supporters and above.",
  member: "Post, react, upload, reply and start threads.",
  timeout: "Read only, until the time out ends.",
};

const NAME_MAX = 40;
/** The colour a role starts from when one is first given. */
const FIRST_COLOUR = "#808080";
const HEX = /^#[0-9a-fA-F]{6}$/;

function RoleEditor({ role, save, onDone }: { role: RoleRow; save: Save; onDone: () => void }) {
  const [label, setLabel] = useState(role.label);
  const [colour, setColour] = useState<string | null>(role.colour);
  const [hoist, setHoist] = useState(role.hoist);
  const [busy, setBusy] = useState(false);
  const name = label.trim();
  // Why Save is off, said beside it (a disabled button alone tells nobody what to fix).
  const why = name.length < 1 ? "A role needs a name."
    : name.length > NAME_MAX ? `A name is ${NAME_MAX} characters at most.`
    : colour !== null && !HEX.test(colour) ? "A colour is written as # and six letters or digits, like #33aa55."
    : null;
  const valid = why === null;
  const whyId = `role-why-${role.key}`;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    const ok = await save(`/api/admin/community/roles/${encodeURIComponent(role.key)}`, "PATCH",
      { label: name, colour: colour === null ? null : colour.toLowerCase(), hoist });
    setBusy(false);
    if (ok) onDone();
  }

  return (
    <form aria-label={`Edit ${role.label}`} className="basis-full space-y-2 pt-1"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label className="flex items-center gap-2 text-xs text-body-dim">
        <span className="w-24 shrink-0">Name</span>
        <input type="text" className={input} value={label} maxLength={NAME_MAX + 10} aria-label="Name"
          onChange={(e) => setLabel(e.target.value)} />
      </label>
      <div className="flex flex-wrap items-center gap-2 text-xs text-body-dim">
        <span className="w-24 shrink-0">Colour</span>
        <Toggle on={colour !== null} label="Use a colour" onToggle={() => setColour(colour === null ? FIRST_COLOUR : null)} />
        {colour !== null && <ColorInput value={colour} onChange={setColour} />}
      </div>
      <div className="flex items-center gap-2 text-xs text-body-dim">
        <Toggle on={hoist} label="Show as its own group in the member list" onToggle={() => setHoist(!hoist)} />
        <span>Show as its own group in the member list</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={btn} disabled={!valid || busy} aria-describedby={why ? whyId : undefined}>Save</button>
        <button type="button" className={btn} onClick={onDone}>Cancel</button>
        {why && <span id={whyId} className="text-xs text-body-dim">{why}</span>}
      </div>
    </form>
  );
}

export default function RolesPage({ roles, save }: { roles: readonly RoleRow[]; save: Save }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <section className={card} aria-label="Roles">
      <h2 className={h2}>Roles</h2>
      <p className="mt-0.5 text-xs text-muted">Each role can do everything the ones below it can. You can change a role&apos;s name and colour, and whether it is its own group in the member list.</p>
      <ul className="mt-3 space-y-2">
        <li className="flex flex-wrap items-baseline gap-x-2" data-role="creator">
          <span className="text-sm text-body">Creator</span>
          <span className="text-2xs text-secondary">The community&apos;s own account. It can do everything and is never listed.</span>
        </li>
        {roles.map((r) => (
          <li key={r.key} className="flex flex-wrap items-baseline gap-x-2 border-t border-edge pt-2" data-role={r.key}>
            <span className="inline-flex items-center gap-1.5 text-sm text-body">
              {r.colour && <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: r.colour }} />}
              {r.label}
            </span>
            {r.hoist && <span className={chip}>Listed apart</span>}
            {editing !== r.key && (
              <button type="button" className={`${btn} ml-auto`} aria-label={`Edit ${r.label}`} onClick={() => setEditing(r.key)}>Edit</button>
            )}
            <span className="basis-full text-2xs text-secondary">{CAN[r.key] ?? "A role of your own, between the ones above and below it."}</span>
            {editing === r.key && <RoleEditor role={r} save={save} onDone={() => setEditing(null)} />}
          </li>
        ))}
      </ul>
    </section>
  );
}
