import { lowerResEmoteUrl } from "./emoteRes.ts";
import { renderMarkdown, escapeHtml } from "./markdown.ts";

export type Mention = { label: string; userId: string };

export type ReplyContext = {
  eventId: string;
  roomId: string;
  senderUserId: string;
  /** The name the reader sees (bridge suffix already stripped). */
  senderLabel: string;
  body: string;
};

function pill(userId: string, label: string): string {
  return `<a href="https://matrix.to/#/${escapeHtml(userId)}">${escapeHtml(label)}</a>`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A run of plain text — no mentions in it — as emotes (single-space tokens) + escaping. */
function wordsToHtml(
  text: string,
  emotes: Record<string, { url: string; zeroWidth: boolean }>
): { html: string; hasEmote: boolean } {
  const words = text.split(" ");
  let hasEmote = false;
  const parts: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (i > 0) parts.push(" ");
    const word = words[i];
    if (!word) continue;
    const cdnUrl = emotes[word]?.url;
    if (cdnUrl) {
      hasEmote = true;
      const src = lowerResEmoteUrl(cdnUrl);
      parts.push(`<img src="${src}" alt="${escapeHtml(word)}" title="${escapeHtml(word)}" height="24" data-mx-emoticon />`);
    } else {
      parts.push(escapeHtml(word));
    }
  }
  return { html: parts.join(""), hasEmote };
}

function textToHtml(
  text: string,
  emotes: Record<string, { url: string; zeroWidth: boolean }>,
  mentions: Mention[]
): { html: string; hasEmote: boolean; mentioned: string[] } {
  if (mentions.length === 0) {
    const { html, hasEmote } = wordsToHtml(text, emotes);
    return { html, hasEmote, mentioned: [] };
  }

  // A mention is matched over the WHOLE text, not word-by-word — a display name
  // can contain a space ("First Last"), and the single-space word split above
  // would otherwise see it as two words and never resolve it. Longest labels
  // first so one label can't shadow another that starts with it.
  const byLabel = new Map(mentions.map((m) => [m.label, m] as const));
  const alternation = [...mentions]
    .sort((a, b) => b.label.length - a.label.length)
    .map((m) => escapeRegExp(m.label))
    .join("|");
  const mentionRe = new RegExp(`(^|(?<=\\s))@(${alternation})([,.!?:;]{0,3})(?=\\s|$)`, "g");

  let hasEmote = false;
  const mentioned: string[] = [];
  const parts: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = mentionRe.exec(text))) {
    const before = text.slice(last, match.index);
    if (before) {
      const seg = wordsToHtml(before, emotes);
      parts.push(seg.html);
      hasEmote = hasEmote || seg.hasEmote;
    }
    const label = match[2]!;
    const trail = match[3] ?? "";
    const m = byLabel.get(label)!;
    if (!mentioned.includes(m.userId)) mentioned.push(m.userId);
    parts.push(pill(m.userId, m.label) + escapeHtml(trail));
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  if (rest) {
    const seg = wordsToHtml(rest, emotes);
    parts.push(seg.html);
    hasEmote = hasEmote || seg.hasEmote;
  }
  return { html: parts.join(""), hasEmote, mentioned };
}

export type MatrixMessageContent = {
  msgtype: string;
  body: string;
  format?: string;
  formatted_body?: string;
  "m.relates_to"?: Record<string, unknown>;
  "m.mentions"?: { user_ids: string[] };
};

/** The text a reader would see in this HTML — tags (incl. emote imgs) removed. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

export function buildMatrixMessage(
  text: string,
  emotes: Record<string, { url: string; zeroWidth: boolean }>,
  reply?: ReplyContext,
  mentions: Mention[] = []
): MatrixMessageContent {
  const result: MatrixMessageContent = { msgtype: "m.text", body: text };
  // Markdown runs first; every plain run inside it goes through the emote +
  // mention renderer, so `**@alice**` is a bold pill and `**OMEGALUL**` a
  // bold emote.
  const mentioned: string[] = [];
  const md = renderMarkdown(text, (run) => {
    const seg = textToHtml(run, emotes, mentions);
    for (const id of seg.mentioned) if (!mentioned.includes(id)) mentioned.push(id);
    return seg.html;
  });
  const mainHtml = md.html;
  const userIds = [...mentioned];

  if (reply) {
    // Plain fallback keeps the spec's `> <mxid> quote` form; the HTML carries
    // the reader-facing label as a pill (matrix.to is what every client and the
    // Discord bridge understand as "a mention of this user").
    result.body = `> <${reply.senderUserId}> ${reply.body}\n\n${text}`;
    const eventLink = `https://matrix.to/#/${escapeHtml(reply.roomId)}/${escapeHtml(reply.eventId)}`;
    const replyBlock = `<mx-reply><blockquote><a href="${eventLink}">In reply to</a> ${pill(reply.senderUserId, reply.senderLabel)}<br/>${escapeHtml(reply.body)}</blockquote></mx-reply>`;
    result.format = "org.matrix.custom.html";
    result.formatted_body = replyBlock + mainHtml;
    result["m.relates_to"] = { "m.in_reply_to": { event_id: reply.eventId } };
    if (!userIds.includes(reply.senderUserId)) userIds.unshift(reply.senderUserId);
  } else if (mentioned.length > 0 || (md.changed && visibleText(mainHtml) !== "")) {
    // A resolved mention needs HTML for the pill; markdown needs it for the
    // formatting. Plain messages (including emote-only ones, even inside
    // markdown) stay body-only: emitting an <img data-mx-emoticon>-only
    // formatted_body once made the Discord bridge send an EMPTY message
    // (mautrix drops the emote img → error 50006), and Element strips
    // external (non-mxc) emote imgs anyway.
    result.format = "org.matrix.custom.html";
    result.formatted_body = mainHtml;
  }
  if (userIds.length > 0) result["m.mentions"] = { user_ids: userIds };
  return result;
}

// The m.replace payload for editing an already-sent message, shared by the main
// timeline and the thread panel — including the "* " prefixes, which are the
// spec's fallback rendering for clients that don't understand edits, and are
// easy to get subtly wrong (they must be applied to the OUTER
// body/formatted_body, never to m.new_content, or every edit renders with a
// literal asterisk forever).
export function buildEditContent(
  text: string,
  emotes: Record<string, { url: string; zeroWidth: boolean }>,
  targetEventId: string,
  mentions: Mention[] = []
): Record<string, unknown> {
  const newContent = buildMatrixMessage(text, emotes, undefined, mentions);
  const editContent: Record<string, unknown> = {
    msgtype: "m.text",
    body: "* " + newContent.body,
    "m.new_content": newContent,
    "m.relates_to": { rel_type: "m.replace", event_id: targetEventId },
  };
  if (newContent.format && newContent.formatted_body) {
    editContent.format = newContent.format;
    editContent.formatted_body = "* " + newContent.formatted_body;
  }
  // MSC3952: the outer content carries the edit's own mentions, m.new_content
  // the full replacement set (buildMatrixMessage already put them there).
  if (newContent["m.mentions"]) editContent["m.mentions"] = newContent["m.mentions"];
  return editContent;
}
