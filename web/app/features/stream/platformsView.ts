// The Stream tab's ONE Platforms card, as data: the site's side of each platform (set up, embed
// switch, title — GET /api/admin/stream/platforms) and the chat reader's side (running / starting /
// failed and why, live detection — the ingest's health answer, ingestReaders.ts) joined into one row
// per platform. Pure: the card renders what this returns. Nothing either side said is dropped — a
// platform only the reader knows still gets its row, after the site's own.
import { platformLabel } from "../../lib/platforms.ts";
import type { PlatformRow } from "../../lib/streamStats.ts";
import type { ReaderRow } from "./ingestReaders.ts";

export type MergedPlatformRow = {
  key: string;
  label: string;
  /** The site's side; null for a platform only the chat reader service reports. */
  site: PlatformRow | null;
  /** The chat reader's side; null when the reader service has no row for it (the site player,
   *  a platform it does not read, or the service not answering). */
  reader: ReaderRow | null;
};

/** Site rows in the server's order, each with its reader row; then reader-only rows in theirs. */
export function mergePlatformRows(site: readonly PlatformRow[] | null, readers: readonly ReaderRow[]): MergedPlatformRow[] {
  const byKey = new Map(readers.map((r) => [r.platform, r]));
  const out: MergedPlatformRow[] = (site ?? []).map((s) => ({ key: s.key, label: s.label, site: s, reader: byKey.get(s.key) ?? null }));
  for (const r of readers) {
    if (out.some((m) => m.key === r.platform)) continue;
    out.push({ key: r.platform, label: platformLabel(r.platform), site: null, reader: r });
  }
  return out;
}
