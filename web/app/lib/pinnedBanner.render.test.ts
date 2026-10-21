// PinnedBanner — expanded by default, wearing its author's style and badges.
//
// Run: node --test app/lib/pinnedBanner.render.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { stripComments, stripCssComments } from "./testSource.ts";
// Static, and BEFORE the component import: registers the resolver that lets a
// .tsx specifier load at all (iconRail.render.test.ts's header explains why).
import "./testTsx.ts";
const { default: PinnedBanner } = await import("../components/PinnedBanner.tsx");
const { BadgesProvider } = await import("./BadgesContext.tsx");
const { DEFAULT_NAME_COLOR } = await import("./colors.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const src = stripComments(readFileSync(path.join(here, "..", "components", "PinnedBanner.tsx"), "utf8"));

const pin = {
  id: 1, platform: "twitch", messageId: 7, username: "casey", message: "a long pinned line " + "x".repeat(300),
  emotes: null, auto: false, pinnedBy: "@casey:site.test", ts: 0,
};
const render = (p: object) =>
  renderToStaticMarkup(createElement(PinnedBanner, { pin: { ...pin, ...p }, emotes: {}, isMod: false, onUnpin: () => {}, onDismiss: () => {} } as never));

test("the banner opens EXPANDED: the text wraps, it is not clamped to one line", () => {
  const html = render({});
  assert.match(html, /class="break-words"/, "the message renders in its expanded form");
  assert.doesNotMatch(html, /line-clamp-1/, "…not collapsed to one line");
  // Expanded for EVERY pin, not just the first after a reload: the banner
  // stays mounted while pins replace each other, so the state is WHICH pin was
  // collapsed and a new pin is expanded by derivation.
  assert.match(src, /const \[collapsedPinId, setCollapsedPinId\] = useState<number \| null>\(null\)/);
  assert.match(src, /const expanded = collapsedPinId !== pin\.id;/, "a different pin is never the collapsed one");
  assert.match(src, /setCollapsedPinId\(\(c\) => \(c === pin\.id \? null : pin\.id\)\)/, "the tap toggles THIS pin's collapse");
  assert.doesNotMatch(src, /useState\(true\)|useState\(false\)/, "no boolean that would carry a collapse to the next pin");
});

test("the author's equipped style wraps ONLY the name, on the author's colour — the same engine as a chat row", () => {
  // A font style emits its stack on the NAME span only.
  const html = render({ usernameColor: "#00ccff", usernameStyle: { font: "gothic" } });
  const name = /<span data-pin-name="" style="[^"]*"><span(?: class="[^"]*")? style="([^"]*)">casey<\/span>/.exec(html)?.[1] ?? "";
  assert.match(name, /font-family:var\(--font-pirata\)/, "the equipped font is on the name");
  assert.doesNotMatch(html.replace(name, ""), /--font-pirata/, "…and nowhere else");
  assert.match(src, /usernameStyleCSS\(pin\.usernameStyle, /, "the shared style engine, on the pin's own style");
  assert.match(src, /usernameStyleAnimClass\(pin\.usernameStyle\)/, "an animated style gets the reduced-motion class like a chat row");
  // Without a style set the name is still the plain colour.
  const plain = render({ usernameColor: "#00ccff" });
  assert.match(plain, /color:#00ccff|color:#00CCFF/i, "the site colour is the name colour");
  const platform = render({});
  // No author colour: the same default a chat row falls back to (ChatMessage:
  // a platform author with no per-user colour is DEFAULT_NAME_COLOR, never the
  // platform's brand colour) — the banner must not diverge here.
  assert.match(platform, new RegExp(`color:${DEFAULT_NAME_COLOR}`, "i"), "no author colour: the chat row's default");
  // Badges follow the viewer's badge-size setting like every other badge row.
  assert.match(src, /height: rowBasisCalc\('1\.10 \* var\(--chat-badge-scale, 1\)'\)/, "banner badges scale with --chat-badge-scale");
});

test("badges render before the name from BadgesContext, keyed on the pin's matrixId", () => {
  assert.match(src, /badgesForMatrixId\(badgeState, pin\.matrixId\)/, "the badge lookup is the shared one, on the pin's author");
  assert.match(src, /className="chat-badges"/, "the same badge row class as a chat row");
  // Rendered inside a provider with no catalog the row is simply absent — and
  // with no matrixId at all nothing is even looked up.
  const html = renderToStaticMarkup(createElement(BadgesProvider, null, createElement(PinnedBanner, { pin, emotes: {}, isMod: false, onUnpin: () => {}, onDismiss: () => {} } as never)));
  assert.doesNotMatch(html, /chat-badges/, "no badges → no badge row");
});

// The pinned message floats rather than sitting as a flat block, the username
// carries a ':', and the pin icon is the monocolour one.
test("the name is followed by the chat row's plain colon — outside the style set", () => {
  const html = render({ usernameColor: "#00ccff", usernameStyle: { font: "gothic" } });
  // Directly after the name span, muted, and carrying the gap the name otherwise would.
  assert.match(html, />casey<\/span><\/span><span class="text-muted mr-1\.5">:<\/span>/);
  const colon = /<span class="text-muted mr-1\.5"[^>]*>:<\/span>/.exec(html)?.[0] ?? "";
  assert.doesNotMatch(colon, /font-pirata|style=/, "the equipped style never reaches the colon");
});

// The pin icon is the unpin control, so no settings icon or x eats the
// banner's horizontal space.
test("the pin mark is the one-colour icon — and it IS the unpin / hide control; there is no ✕", () => {
  const html = render({});
  assert.doesNotMatch(html, /📌|✕/);
  assert.match(html, /<svg[^>]*fill="currentColor"/, "drawn in the text colour");
  assert.match(src, /import \{ PushPin, PushPinSlash \} from "@phosphor-icons\/react\/dist\/ssr";/);
  // Exactly two buttons: the pin, then the message (tap to collapse).
  const buttons = html.match(/<button\b[^>]*>/g) ?? [];
  assert.equal(buttons.length, 2, "pin + message, nothing else");
  assert.match(buttons[0] ?? "", /data-pin-control/);
  assert.match(src, /data-pin-control\s+onClick=\{isMod \? onUnpin : onDismiss\}/, "a mod unpins for everyone; anyone else hides it");
  // What it does AND why the pin is up, to a pointer and to a screen reader.
  assert.match(buttons[0] ?? "", /title="Pinned by a moderator — click to hide"/);
  assert.match(buttons[0] ?? "", /aria-label="Pinned by a moderator — click to hide"/);
  assert.match(render({ auto: true }), /title="Pinned by chat \(\+5\) — click to hide"/);
  const mod = renderToStaticMarkup(createElement(PinnedBanner, { pin, emotes: {}, isMod: true, onUnpin: () => {}, onDismiss: () => {} } as never));
  assert.match(mod, /title="Pinned by a moderator — click to unpin for everyone"/);
});

// The pinned message matches the chat message font, size and spacing.
test("the pinned text is set like a chat row: same class, size, line height, font, weight — and the name takes the username settings", () => {
  const html = render({});
  const msgBtn = (html.match(/<button\b[^>]*>/g) ?? [])[1] ?? "";
  // The row's own class: text shadow, badge and emote shadows all follow.
  assert.match(msgBtn, /class="chat-msg-body /);
  assert.match(msgBtn, /font-size:var\(--chat-font-size, 0\.875rem\)/);
  assert.match(msgBtn, /line-height:var\(--chat-line-height, 1\.4\)/);
  assert.match(msgBtn, /font-family:var\(--chat-font-family, inherit\)/);
  assert.match(msgBtn, /font-weight:var\(--chat-font-weight, 400\)/);
  assert.doesNotMatch(html, /--text-chat-md/, "the 0.88 step is gone from the banner");
  assert.match(src, /fontSize: CHAT_FONT,/, "from the one chat-size token");
  // The name's outer span carries what a chat row's name button carries.
  const nameOuter = /<span data-pin-name="" style="([^"]*)">/.exec(html)?.[1] ?? "";
  assert.match(nameOuter, /font-family:var\(--chat-username-font, inherit\)/);
  assert.match(nameOuter, /font-weight:var\(--chat-username-weight, 600\)/);
  assert.match(nameOuter, /font-size:var\(--chat-font-size, 0\.875rem\)/, "usernameSize is removed — the name rides CHAT_FONT directly");
  assert.match(nameOuter, /filter:saturate\(var\(--chat-username-sat, 1\)\)/);
  assert.doesNotMatch(html, /font-semibold/, "the fixed weight would beat the username-weight setting");
});

test("the banner FLOATS: an inset, rounded, bordered card — and the measured box still includes the inset", () => {
  const html = render({});
  // Outer box: the overlay the scroller pads by. It carries the inset as
  // PADDING, so offsetHeight (what onHeightChange reports) covers card + gaps
  // and nothing hides under the float. It must not eat clicks beside the card.
  const outer = /^<div class="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.match(outer, /\babsolute top-0 left-0 right-0 z-10\b/);
  assert.match(outer, /\bp-1\.5\b/, "the inset is padding on the measured box");
  assert.match(outer, /\bpointer-events-none\b/);
  assert.doesNotMatch(outer, /border-b/, "no longer a full-width strip with a bottom rule");
  // The card itself.
  const card = /<div class="(pin-card[^"]*)" style="([^"]*)"/.exec(html);
  assert.ok(card, "the card is gone");
  const [, cardClass = "", cardStyle = ""] = card;
  assert.match(cardClass, /\brounded-lg\b/);
  assert.match(cardClass, /\bborder\b/);
  assert.match(cardClass, /\bpointer-events-auto\b/);
  assert.match(cardStyle, /background:var\(--glass-bg/);
  assert.match(cardStyle, /box-shadow:var\(--pin-shadow/);
  // The ref — and so the height report — stays on the OUTER box.
  assert.match(src, /<div\s+ref=\{ref\}\s+className="absolute top-0/);
  // A shadow with a negative spread is a strip's shadow: it hides the sides,
  // and a floating card has sides.
  const css = stripCssComments(readFileSync(path.join(here, "..", "globals.css"), "utf8"));
  const shadow = /--pin-shadow:\s*([^;]+);/.exec(css)?.[1] ?? "";
  assert.ok(shadow, "--pin-shadow left globals.css");
  assert.doesNotMatch(shadow, /px -\d/, "negative spread is back");
  assert.match(src, /\}\s*$/);
});
