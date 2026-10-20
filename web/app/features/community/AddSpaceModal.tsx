"use client";

import { useState } from "react";
import { Window } from "@/app/components/chrome";
import { Preset, RoomType } from "matrix-js-sdk";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { matrixServerName } from "@/app/lib/matrixConfig";

// Minimal add-space surface: create a new space, or join an existing one by
// alias. Full space administration (settings, invites, power levels) is a later
// phase — this just unblocks the "+" rail button.

export function AddSpaceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (roomId: string) => void;
}) {
  const { client } = useMatrixClient();
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createSpace() {
    if (!client || !name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { room_id } = await client.createRoom({
        name: name.trim(),
        creation_content: { type: RoomType.Space },
        preset: Preset.PrivateChat,
      });
      onCreated(room_id);
    } catch (e) {
      console.error("[Matrix] create space failed", e);
      setError("Couldn't create the space.");
      setBusy(false);
    }
  }

  async function joinByAlias() {
    const a = alias.trim();
    if (!client || !a || busy) return;
    setBusy(true);
    setError(null);
    try {
      const room = await client.joinRoom(a.startsWith("#") || a.startsWith("!") ? a : `#${a}`);
      onCreated(room.roomId);
    } catch (e) {
      console.error("[Matrix] join space failed", e);
      setError("Couldn't join — check the alias.");
      setBusy(false);
    }
  }

  return (
    <Window presentation="dialog" name="Add a space" title="Add a space" onClose={onClose} width={384}>
      <div className="p-5 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label className="text-secondary text-xs uppercase tracking-wider font-semibold">Create a space</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createSpace(); }}
            placeholder="Space name"
            className="bg-scrim border border-control rounded-md px-3 py-1.5 text-sm text-heading outline-none focus:border-accent"
          />
          <button
            onClick={createSpace}
            disabled={!name.trim() || busy}
            className="self-start rounded-md px-3 py-1.5 text-sm font-semibold text-on-accent disabled:opacity-40 hover:brightness-110 transition-all"
            style={{ backgroundColor: "var(--accent)" }}
          >
            Create
          </button>
        </div>

        <div className="h-px bg-control/60" />

        <div className="flex flex-col gap-2">
          <label className="text-secondary text-xs uppercase tracking-wider font-semibold">Join by alias</label>
          <input
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") joinByAlias(); }}
            placeholder={`#space:${matrixServerName()}`}
            className="bg-scrim border border-control rounded-md px-3 py-1.5 text-sm text-heading outline-none focus:border-accent"
          />
          <button
            onClick={joinByAlias}
            disabled={!alias.trim() || busy}
            className="self-start rounded-md px-3 py-1.5 text-sm font-semibold border border-control text-body disabled:opacity-40 hover:bg-surface-1 transition-all"
          >
            Join
          </button>
        </div>

        {error && <p className="text-rose-400 text-xs">{error}</p>}
      </div>
    </Window>
  );
}
