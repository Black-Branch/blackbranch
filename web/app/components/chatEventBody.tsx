"use client";

import { renderText } from "@/app/lib/renderText";
import { Star, MoneyWavy } from "@phosphor-icons/react/dist/ssr";
import PointsIcon from "./PointsIcon";
import { normalizeUsername, type ChatMsg } from "@/app/lib/chatMsg";
import { formatMoney, formatNameList } from "@/app/lib/chatFormat";
import { currencyLabel } from "@/app/lib/currency";
import type { EmoteMap } from "@/app/lib/useEmotes";

// Which glyph marks a support type — sub/membership vs coin-like currency vs a
// straight donation. External alerts (Twitch/YouTube/Kick/Ko-fi/Patreon/
// Streamlabs) don't carry a `system` kind of their own, so we classify by
// stream-api's `eventType` — the full vocabulary across every platform's
// alert (see stream-ingest/lib/alerts.js + stream-api/webhooks.js).
const ALERT_MEMBERSHIP_TYPES = new Set([
  "sub", "resub", "giftsub", "giftbomb", "prime-upgrade", "gift-paid-upgrade",
  "pay-it-forward", "membership", "membership-milestone", "membership-new",
  "membership-gift", "pledge-create",
]);
const ALERT_CURRENCY_TYPES = new Set(["bits", "kicks"]);
function eventIconComponent(msg: ChatMsg): typeof Star | typeof PointsIcon | null {
  switch (msg.system) {
    case "sub":
    case "gift":
      return Star;
    case "cheer":
    case "sound":
      return PointsIcon;
    case "donation":
      return MoneyWavy;
    case "alert": {
      const t = msg.eventType || "";
      return ALERT_MEMBERSHIP_TYPES.has(t) ? Star : ALERT_CURRENCY_TYPES.has(t) ? PointsIcon : MoneyWavy;
    }
    default:
      return null;
  }
}

// Monetization/coin-spend events (gift/donation/sub/cheer/tts/sound, plus
// external-platform alerts) render through the SAME row as any other
// chat message — platform-colored indicator, badges, username style — rather
// than a boxed card. This builds just the event's description,
// which becomes the message body; identity/indicator/badges already flow
// through unchanged because these messages carry the same username/
// usernameColor/usernameStyle/matrixId/platform fields a normal message does
// (see stream-api's alert.js buildEventCard + history/route.ts's live-identity
// merge for matrix-linked kinds). The label text is colored with the row's own
// platform-source indicator color (not bold) plus a duotone icon for the
// support type, so it stands out without a boxed card.
/** `mask` = Behavior › Hide swear words (the viewer's own choice; tip/TTS text included). */
export function eventBody(msg: ChatMsg, emotes: EmoteMap, accentColor: string, mask = false): React.ReactNode {
  const Icon = eventIconComponent(msg);
  const icon = Icon ? (
    <Icon
      weight="duotone"
      size="1em"
      style={{ color: accentColor, display: "inline-block", verticalAlign: "-0.15em", marginRight: "0.35em", flexShrink: 0 }}
    />
  ) : null;
  const label = (text: React.ReactNode) => <span style={{ color: accentColor }}>{text}</span>;
  // The user's own typed text (donation/cheer/TTS/bot note), set apart from
  // the generated label with italics.
  const quoted = (text?: string) =>
    text ? <> <span className="italic text-body">{renderText(text, emotes, msg.emotes, undefined, { mask })}</span></> : null;
  switch (msg.system) {
    case "gift": {
      const recipients = msg.recipients ?? [];
      const names = recipients.map((r) => r.name).filter(Boolean);
      const count = msg.count ?? names.length;
      const months = msg.months ?? 1;
      const monthLabel = months === 1 ? "1 month" : `${months} months`;
      return (
        <>
          {icon}{label(<>gifted {count === 1 ? "1 sub" : `${count} subs`}</>)}
          {" "}to <span className="text-strong">{formatNameList(names)}</span>
          {" "}<span className="text-muted">· {monthLabel}</span>
        </>
      );
    }
    case "donation":
      return (
        <>
          {icon}{label(<>tipped {formatMoney(msg.amount ?? 0, msg.currency ?? "usd")}</>)}
          {quoted(msg.message)}
        </>
      );
    case "sub": {
      // months > 1 is a RENEWAL (the billing webhook's invoice.paid path sends
      // the tenure); the first month says nothing about duration.
      const months = msg.months ?? 1;
      return (
        <>
          {icon}{label(<>{months > 1 ? "resubscribed" : "subscribed"} <span className="text-muted">· {msg.tier || "Supporter"}{months > 1 ? ` · ${months} months` : ""}</span></>)}
        </>
      );
    }
    case "cheer":
      return (
        <>
          {icon}{label(<>cheered {currencyLabel(msg.coins ?? 0)}</>)}
          {quoted(msg.message)}
        </>
      );
    case "highlight":
    case "tts_msg":
      // No label, no italics, and no points icon: a bought message reads as an
      // ordinary chat message; what marks a highlight as
      // paid is the row's card treatment in ChatMessage.tsx (paidHighlight),
      // and a tts_msg is marked by being read aloud, not by its row.
      return msg.message ? renderText(msg.message, emotes, msg.emotes, undefined, { mask }) : null;
    case "sound":
      return <>{icon}{label(<>played {msg.label || "a sound"}</>)}</>;
    case "alert":
      return (
        <>
          {icon}{label(msg.label ?? "")}
          {/* Donation alerts carry a pre-formatted amount (Ko-fi/Streamlabs/
              streamplace); sub-family alerts deliberately don't — see
              ChatMsg.amountText. Muted `· $x` matches the sub card's tier. */}
          {msg.amountText ? <span className="text-muted"> · {msg.amountText}</span> : null}
          {msg.recipient ? <span className="text-secondary"> → {normalizeUsername(msg.recipient)}</span> : null}
          {quoted(msg.message)}
        </>
      );
    default:
      return renderText(msg.message, emotes, msg.emotes, undefined, { mask });
  }
}
