// The one-word label a preview shows for a media message (reply quote, thread
// chip, threads list). Every site calls this so the set of kinds lives once.

import { isPollStartType } from "./pollStart.ts";

export function mediaKindLabel(evType: string, msgtype: unknown): string | null {
  if (evType === "m.sticker") return "📷 Image";
  if (isPollStartType(evType)) return "📊 Poll";
  switch (msgtype) {
    case "m.image": return "📷 Image";
    case "m.video": return "🎬 Video";
    case "m.audio": return "🎵 Audio";
    case "m.file": return "📎 File";
    default: return null;
  }
}
