// The boot sequence: "Loading Matrix… Preparing encryption…" as a rail of stage
// marks, rendered from the readiness view.
// Never a bare spinner; a failed stage renders honestly with the retry.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dom, React, act } from "../testDom.ts";
import "../testTsx.ts";
import { stripCssComments } from "../testSource.ts";
import { registerReadiness, _resetReadinessForTests } from "../readiness.ts";
const { BootSequence } = await import("@/app/components/chrome");
const { createRoot } = await import("react-dom/client");

const here = dirname(fileURLToPath(import.meta.url));
const MATRIX = [{ id: "sdk", label: "Loading Matrix" }, { id: "crypto", label: "Preparing encryption" }] as const;

function mount(props: { keys: readonly string[]; label: string; onRetry?: () => void; compact?: boolean }) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(BootSequence, props)));
  const el = host.querySelector(".chrome-boot")! as HTMLElement;
  return { el, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

test("renders every stage as a rail row carrying its status, with the eyebrow and an accessible summary", async () => {
  _resetReadinessForTests();
  const r = registerReadiness("matrix", MATRIX);
  r.advance("sdk", "done"); r.advance("crypto", "active");
  const m = mount({ keys: ["matrix"], label: "Joining the community" });
  try {
    assert.equal(m.el.getAttribute("role"), "status");
    assert.equal(m.el.getAttribute("aria-live"), "polite");
    assert.equal(m.el.dataset.phase, "loading");
    assert.equal(m.el.querySelector(".chrome-boot-eyebrow")?.textContent, "Joining the community");
    const rows = [...m.el.querySelectorAll(".chrome-boot-stage")] as HTMLElement[];
    assert.deepEqual(rows.map((li) => [li.dataset.status, li.querySelector(".chrome-boot-label")?.textContent]), [["done", "Loading Matrix"], ["active", "Preparing encryption"]]);
    assert.equal(m.el.querySelector(".sr-only")?.textContent, "Joining the community: Preparing encryption", "the running stage is what a screen reader hears");
    assert.equal(m.el.querySelector(".chrome-boot-retry"), null, "no retry while loading");
    await act(async () => { r.advance("crypto", "done"); });
    assert.equal(m.el.dataset.phase, "ready");
  } finally { m.unmount(); }
});

test("a failed stage renders its reason and a Try again control that calls onRetry — never a silently stuck stage", async () => {
  _resetReadinessForTests();
  const r = registerReadiness("matrix", MATRIX);
  r.advance("sdk", "error", "The chat engine didn't load");
  let retried = 0;
  const m = mount({ keys: ["matrix"], label: "Joining the community", onRetry: () => { retried++; } });
  try {
    assert.equal(m.el.dataset.phase, "error");
    assert.equal(m.el.querySelector('.chrome-boot-stage[data-status="error"] .chrome-boot-detail')?.textContent, "The chat engine didn't load");
    assert.equal(m.el.querySelector(".sr-only")?.textContent, "Joining the community: Loading Matrix failed");
    const btn = m.el.querySelector(".chrome-boot-retry") as HTMLButtonElement;
    assert.equal(btn?.textContent, "Try again");
    assert.equal(btn.type, "button", "never a submit — a boot sequence can sit inside a form (the settings panel)");
    act(() => { btn.click(); });
    assert.equal(retried, 1);
  } finally { m.unmount(); }
  const n = mount({ keys: ["matrix"], label: "Joining the community" });
  try {
    assert.equal(n.el.querySelector(".chrome-boot-retry"), null, "without onRetry the error renders with no control — honest, not a dead button");
  } finally { n.unmount(); }
});

test("compact drops the eyebrow and marks the root, for inline hosts like a settings section", () => {
  _resetReadinessForTests();
  registerReadiness("matrix", MATRIX);
  const m = mount({ keys: ["matrix"], label: "Connecting to Matrix", compact: true });
  try {
    assert.equal(m.el.querySelector(".chrome-boot-eyebrow"), null);
    assert.ok(m.el.hasAttribute("data-compact"));
    assert.equal(m.el.querySelector(".sr-only")?.textContent, "Connecting to Matrix: waiting", "nothing active yet: the summary says so rather than naming a stage");
  } finally { m.unmount(); }
});

test("with no registrant yet the sequence is idle and empty — a surface can compose a key before its subsystem exists", () => {
  _resetReadinessForTests();
  const m = mount({ keys: ["dm"], label: "Opening" });
  try {
    assert.equal(m.el.dataset.phase, "idle");
    assert.equal(m.el.querySelectorAll(".chrome-boot-stage").length, 0);
  } finally { m.unmount(); }
});

test("chrome.css: the only motion is the active mark's compositor pulse, eased fills on the house token, and reduced motion strips both", () => {
  const raw = readFileSync(join(here, "../../components/chrome/chrome.css"), "utf8");
  assert.match(raw.slice(-200), /\}\s*$/, "chrome.css did not end as expected — the read is truncated and every assertion below is vacuous");
  const css = stripCssComments(raw);
  assert.match(css, /\.chrome-boot-stage\[data-status="active"\] \.chrome-boot-mark \{[^}]*animation: chrome-boot-pulse/);
  assert.match(css, /@keyframes chrome-boot-pulse \{[^}]*opacity[^}]*transform: scale/, "opacity + scale: compositor properties only — nothing lays out per frame (the motion-system list)");
  assert.match(css, /\.chrome-boot-mark \{[^}]*transition: background var\(--anim-default\) var\(--anim-ease\), border-color var\(--anim-default\) var\(--anim-ease\)/, "a completing stage's fill eases on the house token");
  assert.match(css, /\.chrome-boot-stage\[data-status="active"\] \.chrome-boot-label::after \{ content: "…"; \}/, "the ellipsis is drawn, not typed: labels stay sentence-case nouns");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.chrome-boot-mark \{ animation: none; transition: none; \}/, "reduced motion: no pulse, no eased fill");
  // Scoped to the boot-sequence block, not the whole file:
  // chrome.css legitimately carries raw `#000` inside mask-image
  // gradients (the tab-strip and chip-row fades), which is what the mask
  // technique requires and is not what check-tokens.mjs's raw-color rules
  // target — a whole-file sweep here would fail on content unrelated to
  // the boot sequence.
  const bootBlock = css.slice(css.indexOf(".chrome-boot"), css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.doesNotMatch(bootBlock, /#[0-9a-f]{3,8}\b|rgba?\(/i, "no raw colors in the boot-sequence CSS — tokens only");
});
