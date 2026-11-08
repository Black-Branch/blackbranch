"use client";

// The Admin Panel's Moderators and Staff: who holds each role, adding and removing it (admin only).
// Moderators: the same route as the `/mod` and `/unmod` commands and the user card's Make / Remove
// moderator; their power in the community rooms follows at the owner's next visit to the community
// (useModPowerSync), in both directions. Staff (site.users.is_staff): the community's reconciler
// applies it (spec 2026-10-23 §4.2). The two flags are separate; the community ladder gives the higher.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { getJson, postJson } from "@/app/lib/http";
import { LoadingState } from "@/app/components/Spinner";
import { matrixServerName } from "@/app/lib/matrixConfig";
import { card, h2, btn, input, timeAgo, shortName, resolveTarget } from "../shared";

type Holder = { matrixId: string; displayName: string | null; since: string | null };

type RoleCopy = {
  route: string;
  /** The GET answer's list key. */
  listKey: "moderators" | "staff" | "admins";
  title: string;
  about: ReactNode;
  add: string;
  /** The name field's accessible name. */
  addLabel: string;
  remove: string;
  empty: string;
  given: (name: string) => string;
  taken: (name: string) => string;
};

function RoleList({ copy, note }: { copy: RoleCopy; note: (m: string) => void }) {
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const { route, listKey } = copy;

  const load = useCallback(() => {
    getJson<Record<string, Holder[]>>(route).then((d) => setHolders(d[listKey] ?? [])).catch(() => setHolders([]));
  }, [route, listKey]);
  useEffect(load, [load]);

  async function setRole(targetId: string, grant: boolean, displayName: string | null = null) {
    setBusy(true);
    try {
      const res = await postJson(route, { targetId, grant });
      if (res.status === 404) note("No account by that name.");
      // A refusal the server explains (the last admin): its own words.
      else if (res.status === 409) note(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't change the role.");
      else if (!res.ok) note("Couldn't change the role. Try again.");
      else {
        const who = shortName(targetId, displayName);
        note(grant ? copy.given(who) : copy.taken(who));
        if (grant) setName("");
      }
      load();
    } catch {
      note("Couldn't change the role. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={card}>
      <h2 className={h2}>{copy.title}</h2>
      <p className="mb-3 text-xs text-muted">{copy.about}</p>
      <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void setRole(resolveTarget(name), true); }}>
        <input className={input} value={name} onChange={(e) => setName(e.target.value)}
          placeholder={`username or @user:${matrixServerName()}`} aria-label={copy.addLabel} />
        <button type="submit" className={btn} disabled={busy || !name.trim()}>{copy.add}</button>
      </form>
      {holders === null ? (
        <LoadingState />
      ) : holders.length === 0 ? (
        <p className="text-sm text-muted">{copy.empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {holders.map((m) => (
            <li key={m.matrixId} className="flex items-center gap-3 rounded-lg bg-surface-1 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <span className="font-medium text-body">{shortName(m.matrixId, m.displayName)}</span>
                <span className="ml-2 text-xs text-muted">{m.matrixId}</span>
                {m.since && <span className="ml-2 text-xs text-muted">since {timeAgo(m.since)}</span>}
              </div>
              <button type="button" className={btn} disabled={busy} onClick={() => void setRole(m.matrixId, false, m.displayName)}>{copy.remove}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const MODERATORS: RoleCopy = {
  route: "/api/mod/setmod",
  listKey: "moderators",
  title: "Moderators",
  about: <>
    Moderators get the Mod Panel and mod power in the community rooms. Admins have every mod power already.
    In chat: <code>/mod &lt;user&gt;</code> and <code>/unmod &lt;user&gt;</code>.
  </>,
  add: "Make moderator",
  addLabel: "Who to make a moderator",
  remove: "Remove moderator",
  empty: "No moderators yet.",
  given: (who) => `${who} is now a moderator.`,
  taken: (who) => `${who} is no longer a moderator.`,
};

const STAFF: RoleCopy = {
  route: "/api/admin/staff",
  listKey: "staff",
  title: "Staff",
  about: <>
    Staff can do everything a moderator can in the community, and edit its channels. Roles, who can see a
    channel, how long messages are kept and encryption stay with admins. Someone who is a moderator and Staff
    counts as Staff.
  </>,
  add: "Give Staff",
  addLabel: "Who to give Staff",
  remove: "Remove from Staff",
  empty: "No Staff yet.",
  given: (who) => `${who} is now Staff.`,
  taken: (who) => `${who} is no longer Staff.`,
};

const ADMINS: RoleCopy = {
  route: "/api/admin/admins",
  listKey: "admins",
  title: "Admins",
  about: <>
    Admins have the Admin Panel and every power on the site. Any admin can make or remove another, but the site
    always keeps at least one. A second admin is also how you get back in if one admin account is lost.
  </>,
  add: "Make admin",
  addLabel: "Who to make an admin",
  remove: "Remove admin",
  empty: "No admins.",
  given: (who) => `${who} is now an admin.`,
  taken: (who) => `${who} is no longer an admin.`,
};

export function AdminList({ note }: { note: (m: string) => void }) {
  return <RoleList copy={ADMINS} note={note} />;
}

export function StaffList({ note }: { note: (m: string) => void }) {
  return <RoleList copy={STAFF} note={note} />;
}

export default function ModeratorList({ note }: { note: (m: string) => void }) {
  return <RoleList copy={MODERATORS} note={note} />;
}
