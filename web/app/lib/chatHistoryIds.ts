// Who a public chat-history row says wrote it. /api/chat/history needs no sign-in, so its rows are
// public: they carry the sender's per-platform PUBLIC id (publicIdServer.ts), never the canonical
// stream id that ties a person's Twitch, YouTube, Kick and site lines together (owner decision
// 2026-10-17 — the link is shown only where the person shows it). A moderator's page carries the
// canonical too, for the moderation tools. A site line keeps its Matrix id: that is the site
// account's own handle (the community and DMs show it), tied to no other platform. A platform
// line never carries one. Pure — the id maker is passed in — so node --test reads it.
import { isNativePlatform } from "./nativePlatform.ts";

export type HistoryIds = { publicId: string | null; canonicalId?: string | null; matrixId: string | null };

export function historyIds(
  row: { canonical_id?: string | null; matrix_id?: string | null; platform: string },
  isMod: boolean,
  makePublicId: (canonical: string | null | undefined, platform: string) => string | null,
): HistoryIds {
  const native = isNativePlatform(row.platform);
  const ids: HistoryIds = {
    publicId: makePublicId(row.canonical_id ?? null, row.platform),
    matrixId: native ? row.matrix_id ?? null : null,
  };
  if (isMod) ids.canonicalId = row.canonical_id ?? null;
  return ids;
}
