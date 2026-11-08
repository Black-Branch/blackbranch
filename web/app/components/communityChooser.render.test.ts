// The community chooser (per-platform liveness, Task 9; 0134 "the viewer chooses"): with more than
// one community streamer live, the player's bottom bar offers them by name and picture, a countdown
// entry marked "Scheduled"; a pick goes back to StreamView. One entry: no chooser at all.
// A real mount — what the menu shows and what a press does are not visible to a source scan.
// Run: node --test app/components/communityChooser.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dom, React, act } from "../lib/testDom.ts";
import "../lib/testTsx.ts";
import { stripComments } from "../lib/testSource.ts";

const { CommunityChooser } = await import("@/app/components/CommunityChooser");

const entry = (key: string, display_name: string, avatar_url: string | null, scheduled: { startsAt: number | null } | null = null) => ({
  key, display_name, avatar_url, scheduled, youtube_channel_id: key, video_id: "v", stream_title: "", twitch_login: null, sources: [],
});

async function mount(props: Record<string, unknown>) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(CommunityChooser, props as never)); });
  return { container, root };
}

test("one live community streamer: no chooser", async () => {
  const { container, root } = await mount({ communities: [entry("A", "Alpha", null)], shownKey: "A", onPick: () => {} });
  assert.equal(container.innerHTML, "");
  await act(async () => root.unmount());
});

test("two or more: names, pictures and Scheduled; a pick reports the key", async () => {
  const picked: string[] = [];
  const { container, root } = await mount({
    communities: [entry("A", "Alpha", "https://yt3.ggpht.com/a=s48"), entry("O", "Own Show", null, { startsAt: 1_800_000_000_000 })],
    shownKey: "A",
    onPick: (k: string) => picked.push(k),
  });
  const btn = container.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']");
  assert.ok(btn, "a menu button");
  assert.equal(btn.getAttribute("aria-label"), "Choose who to watch (2 streams)");
  assert.equal(container.querySelector("[role='menu']"), null, "closed at rest");
  await act(async () => { btn.click(); });
  const items = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']")];
  assert.equal(items.length, 2);
  assert.equal(items[0]!.getAttribute("aria-checked"), "true");
  assert.equal(items[1]!.getAttribute("aria-checked"), "false");
  assert.match(items[0]!.textContent ?? "", /Alpha/);
  assert.equal(items[0]!.querySelector("img")?.getAttribute("src"), "https://yt3.ggpht.com/a=s48");
  assert.match(items[1]!.textContent ?? "", /Own Show/);
  assert.match(items[1]!.textContent ?? "", /Scheduled/);
  assert.doesNotMatch(items[0]!.textContent ?? "", /Scheduled/);
  assert.match(items[1]!.textContent ?? "", /OS/, "no picture: the initials");
  await act(async () => { items[1]!.click(); });
  assert.deepEqual(picked, ["O"]);
  assert.equal(container.querySelector("[role='menu']"), null, "a pick closes the menu");
  await act(async () => root.unmount());
});

test("wiring: StreamView keeps the pick and shows the target; the meta bar mounts the chooser on the Community tab", () => {
  const view = stripComments(readFileSync(join(import.meta.dirname, "StreamView.tsx"), "utf8"));
  assert.match(view, /const \[communityPick, setCommunityPick\] = useState<string \| null>\(null\);/);
  assert.match(view, /const shownCommunity = communityTarget\(\{ community, communities \}, communityPick\);/);
  assert.match(view, /community=\{shownCommunity\}\s+communitySource=\{communitySource\}/, "the player plays the chosen entry");
  assert.match(view, /onPickCommunity=\{setCommunityPick\}/);
  const bar = stripComments(readFileSync(join(import.meta.dirname, "StreamMetaBar.tsx"), "utf8"));
  assert.match(bar, /\{featured && <CommunityChooser communities=\{communities\} shownKey=\{featured\.key\} onPick=\{onPickCommunity\} \/>\}/);
  assert.match(bar, /\n\}\s*$/, "vacuity: the bar was read to its end");
});
