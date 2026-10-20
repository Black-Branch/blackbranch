// Behavior — WHO a "Hide" press or "/ignore name" means: the id the line carried (chatMsg.ts
// personKey) — a site account's Matrix id, else the sender's per-platform public id. Never the
// canonical: a viewer does not have it, and hiding by it would show the viewer which other
// platforms' lines are the same person's.
// Pure; only type imports, so node --test imports it directly.
import type { ChatDirectory } from "./chatDirectory";

export type HideTarget = { id: string; name: string; matrixId: string | null };

export function personOfMessage(m: { username: string; publicId?: string | null; matrixId?: string | null }): HideTarget | null {
  const id = m.matrixId || m.publicId;
  return id ? { id, name: m.username, matrixId: m.matrixId ?? null } : null;
}

/** A typed name → someone who has spoken in this chat (the @-autocomplete's
 *  directory: display name or Matrix localpart, `@` and case ignored). */
export function resolveChatter(dir: ChatDirectory | null, raw: string): HideTarget | null {
  const key = raw.trim().replace(/^@/, "").toLowerCase();
  if (!dir || !key) return null;
  const p = dir.byKey.get(key);
  const id = p ? p.matrixId || p.publicId : null;
  return p && id ? { id, name: p.name, matrixId: p.matrixId } : null;
}
