// Does this message mention the reader?
//
// One field answers it: m.mentions.user_ids. Verified on real events — our
// composer writes it, mautrix-discord writes it, and a Discord
// user typing a site member's name produces that member's REAL Matrix id, not a
// bridge ghost. So there is no HTML to parse and no display name to match.
//
// @room / @everyone is deliberately absent: nothing we see carries
// m.mentions.room or an @room body.

function mentionedIds(content: Record<string, unknown> | null | undefined): string[] {
  const mentions = content?.["m.mentions"];
  if (!mentions || typeof mentions !== "object") return [];
  const ids = (mentions as { user_ids?: unknown }).user_ids;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * True when `myUserId` is named by this message. An edit REPLACES the mention
 * set, so when the row holds edited content that is what is read — an edit can
 * add a mention or take one away, and the reader should see what the message
 * says now.
 */
export function mentionsMe(
  content: Record<string, unknown> | null | undefined,
  editedContent: Record<string, unknown> | null | undefined,
  myUserId: string
): boolean {
  if (!myUserId) return false;
  const source = editedContent ?? content;
  return mentionedIds(source).includes(myUserId);
}
