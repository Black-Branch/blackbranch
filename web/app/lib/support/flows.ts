// The support panel's prefigured structure — a web customer-service
// assistant. Deterministic by design: every button below resolves without a
// model call; only the free-text leaf hands off to the LLM. Copy is in the
// bot's voice but front-desk register — dry, warm, no bits.

export type SupportAction =
  | { kind: "answer"; text: string }
  | { kind: "report-user" }
  | { kind: "report-bug" }
  | { kind: "free-text" };

export type FlowNode = {
  key: string;
  label: string;
  children?: FlowNode[];
  action?: SupportAction;
  /** The module (config/modules.mjs) this answer is about: offered only while it is shown. */
  module?: string;
};

import { currencyName, currencyTitle, currencyIsMass } from "../currency.ts";

// The currency's own word (currency.ts). A mass noun ("Qorm") takes is / it — the copy below reads
// exactly as k wrote it; a counted plural ("points") takes are / them.
const MASS = currencyIsMass();
const IT = MASS ? "it" : "them";

// Fixed copy, verbatim — do not reword.
export const FIRST_VISIT = "If you need anything, I'm here to help!";
export const CLOSE_HINT = "If you need me again, use /support in chat!";

// Load-time link-account reminder. Delivered as the bot's opener; the chips
// below it are linkNudgeOptions().
export const LINK_NUDGE_LINE =
  "Quick one — link your Twitch/Kick/etc. account and your messages cross-post and your support gets credited. It's in your profile card under Linked accounts. Want the walkthrough?";

// One answer, two homes: the FAQ leaf and the reminder's walkthrough chip must
// never drift apart — same feature, same instructions.
const LINKING_ANSWER =
  "Open your profile card and hit Linked accounts. Linking does two things: your chat can cross-post to that platform, and anything you've supported over there gets credited to the same you over here.";

export const GREETINGS = [
  "What can I help you with today?",
  "How can I help?",
  "What seems to be the issue?",
  "Front desk's open. What do you need?",
];

// Every answer, including the ones about modules this install may not show. SUPPORT_ROOT below is
// what is offered.
const ALL_NODES: FlowNode[] = [
  {
    key: "faq", label: "Quick answers",
    children: [
      {
        key: "faq-points", label: MASS ? `What's ${currencyName()}?` : `What are ${currencyName()}?`,
        action: { kind: "answer", text:
          `${currencyTitle()} ${MASS ? "is" : "are"} the site currency. You buy ${IT} in the coin store (the coin icon by the composer) and spend ${IT} on cheers, stickers and sticker boosts, sounds, badges, and username styles. Buying coins fills your wallet; the stream timer only moves when you actually spend them.` },
      },
      {
        key: "faq-supporter", label: "What does Supporter get me?", module: "stripe",
        action: { kind: "answer", text:
          "Supporter is the subscription tier: you get the badge, redacted messages (/r for a whole message, or ||hide part|| of one), and my grudging respect. Subscribe from the support bar or your profile card. Gift subs count too — the perks follow the gift." },
      },
      {
        key: "faq-linking", label: "Linking my Twitch/Kick/etc.",
        action: { kind: "answer", text: LINKING_ANSWER },
      },
      {
        key: "faq-radio", label: "The radio", module: "radio",
        action: { kind: "answer", text:
          "The Radio tab is the station — I pick the order, you don't get a skip button, that's the bit. The Library shows the whole pool by album: download songs or whole albums, and heart the ones you like so you can find them again (sign-in required for hearts)." },
      },
      {
        key: "faq-encrypted", label: "Redacted messages",
        action: { kind: "answer", text:
          "Supporter-only. Wrap part of a message in two bars — like ||this|| — and that part shows as a blacked-out bar; only Supporters can tap it open. The platforms it is posted to see [REDACTED] there instead. To redact a whole message, type /r before it; to keep redacting, pick Redacted message in the + menu, which stays on until you turn it off. Whole redacted messages stay on the site." },
      },
    ],
  },
  { key: "report-user", label: "Report a user", action: { kind: "report-user" } },
  { key: "report-bug", label: "Report a bug", action: { kind: "report-bug" } },
  {
    key: "howto", label: "How do I…?",
    children: [
      {
        key: "howto-namestyle", label: "Change my name style",
        action: { kind: "answer", text:
          "Open your profile card → Appearance. Colours, fonts and effects live there; some of the flashier ones are Supporter or achievement perks. Changes show up in chat immediately." },
      },
      {
        key: "howto-cheer", label: "Send a cheer",
        action: { kind: "answer", text:
          `Tap the coin chip above the composer, pick an amount, type your message, send. It posts highlighted, spends ${currencyName()}, and moves the stream timer. Big cheers get read out loud — there's a toggle on the chip if you'd rather they weren't.` },
      },
      {
        key: "howto-music", label: "Download the music", module: "radio",
        action: { kind: "answer", text:
          "Radio tab → Library. Every song has a download button, and each album has one that zips the whole thing. Free to keep — the station's whole catalogue is in-house." },
      },
      {
        key: "howto-popout", label: "Pop out the chat",
        action: { kind: "answer", text:
          "The popout button sits in the chat header — it opens chat in its own window, handy for a second monitor or OBS. Note the popout is plain chat: my support desk only lives in the main app." },
      },
    ],
  },
  { key: "other", label: "Something else", action: { kind: "free-text" } },
];

function without(nodes: FlowNode[], off: (m: string) => boolean): FlowNode[] {
  return nodes
    .filter((n) => !n.module || !off(n.module))
    .map((n) => (n.children ? { ...n, children: without(n.children, off) } : n));
}

/** The answers offered for a set of modules not shown. Pure. */
function supportRootFor(offModules: readonly string[]): FlowNode[] {
  return without(ALL_NODES, (m) => offModules.includes(m));
}

/**
 * What the support panel offers. Until the page says which modules it shows
 * (setSupportModulesOff, from the home page's module rule), an answer about a module is NOT
 * offered: the desk must never describe a part this install does not run. A live binding —
 * readers see the current value.
 */
export let SUPPORT_ROOT: FlowNode[] = without(ALL_NODES, () => true);

/** Set the modules this install does not show (config/modules.mjs "ONE RULE"). */
export function setSupportModulesOff(offModules: readonly string[]): void {
  SUPPORT_ROOT = supportRootFor(offModules);
}

/**
 * Synthetic quick-reply offered under every free-text answer: files the
 * user's LAST typed message as the bug body, no retyping ("do you want me to
 * send this as a report?"). NOT part of SUPPORT_ROOT — the hook special-cases
 * the key before the reducer sees it.
 */
export const FILE_LAST_BUG: FlowNode = {
  key: "file-last-bug",
  label: "File that as a bug report",
};

/**
 * The reminder's quick-replies. "Walk me through it" is a normal answer leaf
 * the reducer resolves from the OFFERED options; the dismissal chips carry no
 * action on purpose — ChatSidebar intercepts their keys before the reducer
 * (same pattern as FILE_LAST_BUG) because dismissing is a panel-level act:
 * close + POST /api/nudges, which the conversation knows nothing about.
 */
export const NUDGE_LATER_KEY = "nudge-later";
export const NUDGE_NEVER_KEY = "nudge-never";

export function linkNudgeOptions(offerNever: boolean): FlowNode[] {
  const opts: FlowNode[] = [
    { key: "nudge-walkthrough", label: "Walk me through it", action: { kind: "answer", text: LINKING_ANSWER } },
    { key: NUDGE_LATER_KEY, label: "Not now" },
  ];
  if (offerNever) opts.push({ key: NUDGE_NEVER_KEY, label: "Never ask again" });
  return opts;
}

export function findNode(key: string, nodes: FlowNode[] = SUPPORT_ROOT): FlowNode | null {
  for (const n of nodes) {
    if (n.key === key) return n;
    const hit = n.children ? findNode(key, n.children) : null;
    if (hit) return hit;
  }
  return null;
}
