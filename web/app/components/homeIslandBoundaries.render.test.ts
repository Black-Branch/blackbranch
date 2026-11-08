// The home page never dies from one component (task 185). Each island StreamView renders — the
// embed bar, the player, the meta bar, the desktop dock, the chat sidebar — sits directly inside
// ErrorBoundary, so a render throw in one leaves the rest of the page up with "Something went wrong
// here." in that island's place. A throw from an event handler is NOT a render throw: React reports
// it (window.onerror) and the page carries on; no boundary is involved.
//
// Run: node --test app/components/homeIslandBoundaries.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act, serveJson } from "../lib/testDom.ts";
import "../lib/testTsx.ts";
import { stripComments } from "../lib/testSource.ts";

serveJson({});
const { ErrorBoundary } = await import("./ErrorBoundary.tsx");
const { createRoot } = await import("react-dom/client");

function Thrower(): React.ReactElement {
  throw new Error("an island failed to render");
}

test("a child that throws while rendering leaves its siblings up and shows the fallback in its place", async () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const quiet = console.error;
  console.error = () => {};
  try {
    await act(async () => {
      root.render(React.createElement("div", null,
        React.createElement("span", { id: "player" }, "player"),
        React.createElement(ErrorBoundary, null, React.createElement(Thrower)),
        React.createElement("span", { id: "chat" }, "chat"),
      ));
    });
  } finally {
    console.error = quiet;
  }
  assert.ok(host.querySelector("#player"), "the island before it is still on the page");
  assert.ok(host.querySelector("#chat"), "the island after it is still on the page");
  assert.match(host.textContent ?? "", /Something went wrong here\./);
  await act(async () => { root.unmount(); });
  host.remove();
});

const VIEW = stripComments(readFileSync(new URL("./StreamView.tsx", import.meta.url), "utf8"));

for (const island of ["StreamEmbedBar", "StreamPlayerArea", "StreamMetaBar", "BottomDock", "ChatSidebar"]) {
  test(`StreamView renders <${island}> directly inside an ErrorBoundary`, () => {
    const uses = VIEW.match(new RegExp(`<${island}\\b`, "g")) ?? [];
    assert.equal(uses.length, 1, `<${island}> is rendered once`);
    assert.match(VIEW, new RegExp(`<ErrorBoundary>\\s*<${island}\\b`), `<${island}> has no boundary of its own`);
  });
}

test("vacuity anchor: the scan read StreamView to its last line", () => {
  assert.match(VIEW, /const GuestSupportContent = dynamic\(\(\) => import\("\.\/SupportContent"\), \{ ssr: false \}\);\s*$/);
});
