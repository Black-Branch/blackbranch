// Which urls in a message become link-preview cards.

/** Discord shows at most five embeds per message. Module-private: the only
 *  reader is previewCandidates, and a test import is not a caller for
 *  check-orphans. */
const MAX_LINK_PREVIEWS = 5;

/** A message that already carries a bridged Discord embed gets no cards — the
 *  embed IS the preview, and a card per href would duplicate it several times
 *  over (up to a dozen /api/og fetches for one FixTweet-style message).
 *  Otherwise the first five, in message order. */
export function previewCandidates(urls: string[], hasEmbed: boolean): string[] {
  if (hasEmbed) return [];
  return urls.slice(0, MAX_LINK_PREVIEWS);
}
