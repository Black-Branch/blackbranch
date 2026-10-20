// The About page names only what this install runs (round 5 legal backlog): the chat platforms
// that are set up, subscriptions only with a tier price, and the YouTube uses this install has —
// public channel data only with an API key.
// Run: node --test app/about/aboutFeatures.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../lib/testTsx.ts";
const { AboutFeatures, YoutubeUses } = await import("./AboutFeatures.tsx");

type Facts = Parameters<typeof AboutFeatures>[0]["facts"];
const NONE: Facts = {
  shown: {}, stripe: false, subscriptions: false, paypal: false,
  platforms: { twitch: false, kick: false, streamplace: false },
};
const about = (f: Partial<Facts>) =>
  renderToStaticMarkup(createElement(AboutFeatures, { siteName: "Example Stream", facts: { ...NONE, ...f } })).replace(/<!-- -->/g, "");

test("a fresh install names no chat platform it does not ingest", () => {
  const html = about({});
  assert.ok(html.length > 300, "vacuity: the list rendered");
  assert.doesNotMatch(html, /Twitch|Kick|stream\.place|YouTube/);
  assert.match(html, /<strong class="text-body-dim">Live chat<\/strong> — Example Stream’s own chat, beside the stream\./);
});

test("each set-up platform is named, in order, and only those", () => {
  const html = about({ platforms: { twitch: true, kick: false, streamplace: true }, shown: { youtube: true } });
  assert.match(html, /combines\s+messages from Twitch, YouTube, stream\.place, and Example Stream itself/);
  assert.doesNotMatch(html, /Kick/);
});

test("subscriptions only with a tier price", () => {
  assert.match(about({ stripe: true, subscriptions: true }), /optional subscriptions, donations and gifts/);
  const noTier = about({ stripe: true, subscriptions: false });
  assert.match(noTier, /optional donations and gifts \(processed by\s+Stripe\)/);
  assert.doesNotMatch(noTier, /subscri/i);
  assert.match(about({ paypal: true }), /optional donations \(processed by\s+PayPal\)/);
});

const yt = (publicData: boolean) =>
  renderToStaticMarkup(createElement(YoutubeUses, {
    siteName: "Example Stream", publicData, linking: createElement("li", null, "LINKING-ITEM"),
  })).replace(/<!-- -->/g, "");

test("YouTube: public channel data is claimed only with an API key", () => {
  const both = yt(true);
  assert.match(both, /Example Stream uses YouTube API Services in two ways:/);
  assert.match(both, /Public channel info \(no account access\)/);
  assert.match(both, /LINKING-ITEM/);
  const linkOnly = yt(false);
  assert.match(linkOnly, /Example Stream uses YouTube API Services for one thing:/);
  assert.doesNotMatch(linkOnly, /two ways|Public channel info|subscriber count/);
  assert.match(linkOnly, /LINKING-ITEM<\/li><\/ul>$/, "END anchor: the linking item closes the list");
});
