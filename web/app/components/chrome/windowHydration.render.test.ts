// A window that the SERVER renders (a popout page: /mod, /mod/chat, /admin) must hydrate
// without a mismatch. Every presentation draws through a portal into <body>, which the
// server cannot do. If the server drew nothing and the client's FIRST render drew the
// dialog, React would throw error #418 on every panel page and re-render the page from
// the root. The first client render must equal the server's; the window appears on the
// next one.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/components/chrome/windowHydration.render.test.ts

import "../../lib/testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import "../../lib/testTsx.ts";

const React = (await import("react")).default;
const { renderToString } = await import("react-dom/server");
const { Window } = await import("./Window.tsx");

const PRESENTATIONS = ["page", "floating", "panel", "dialog"] as const;
const element = (presentation: (typeof PRESENTATIONS)[number]) =>
  React.createElement(Window, { presentation, kind: "task", name: "Probe window", onClose: () => {} } as never,
    React.createElement("p", null, "window body"));

// The server pass, with no DOM at all — exactly what Next's server render sees. testTsx.ts
// installs jsdom on import, so its globals are lifted off for this pass and put back after.
const g = globalThis as unknown as Record<string, unknown>;
const lifted = { window: g.window, document: g.document };
delete g.window;
delete g.document;
assert.equal(typeof g.document, "undefined", "the server pass must run with no DOM");
const serverHtml = Object.fromEntries(PRESENTATIONS.map((p) => [p, renderToString(element(p))]));
Object.assign(g, lifted);

const { dom, act } = await import("../../lib/testDom.ts");
const { installResizeObserverStub } = await import("../../lib/testTsx.ts");
installResizeObserverStub();
const { hydrateRoot } = await import("react-dom/client");

for (const presentation of PRESENTATIONS) {
  test(`a server-rendered ${presentation} window hydrates without a mismatch, then shows`, async () => {
    const doc = dom.window.document;
    doc.body.innerHTML = "";
    const shell = doc.createElement("div");
    shell.id = "app-shell";
    shell.innerHTML = serverHtml[presentation]!;
    doc.body.appendChild(shell);
    const recoverable: unknown[] = [];
    const root = await (async () => {
      let r: ReturnType<typeof hydrateRoot> | null = null;
      await act(async () => {
        r = hydrateRoot(shell, element(presentation), { onRecoverableError: (e) => { recoverable.push(e); } });
      });
      return r!;
    })();
    assert.deepEqual(recoverable.map((e) => String((e as Error)?.message ?? e)), [], "hydration reported a mismatch");
    const dialog = doc.querySelector('[aria-label="Probe window"]');
    assert.ok(dialog, "the window renders once hydration is done");
    assert.match(dialog!.textContent ?? "", /window body/);
    await act(async () => { root.unmount(); });
  });
}
