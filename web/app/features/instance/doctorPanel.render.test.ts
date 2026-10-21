// Admin Panel → Doctor's header, mounted over a mixed set of rows: one line per group from
// DOCTOR.summary (the same words `blackbranch doctor` prints) — its count, its words and, when it
// has rows, what it asks of the reader — never four bare chips that read as one number.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/instance/doctorPanel.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { default: DoctorPanel } = await import("./DoctorPanel.tsx");
const { DOCTOR } = await import("../../lib/doctor.generated.mjs");
const { createRoot } = await import("react-dom/client");

const row = (id: string, status: string) => ({ id, area: "Site", title: `Check ${id}`, status, detail: "", fix: status === "fail" || status === "warn" ? `fix ${id}` : "" }) as never;
const rows = [row("a", "fail"), row("b", "warn"), row("c", "warn"), row("d", "ok"), row("e", "ok"), row("f", "ok"), row("g", "grey")];
const view = { rows, bundle: false, hostAt: null, siteAt: new Date().toISOString(), hostNote: null };
globalThis.fetch = (async () => new Response(JSON.stringify(view), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

async function mount() {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(DoctorPanel as never)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { el, done: async () => { await act(async () => { root.unmount(); el.remove(); }); } };
}

test("one line per group, in the doctor's order, with its count, words and meaning", async () => {
  const groups = DOCTOR.summary(rows) as { status: string; words: string; meaning: string; n: number }[];
  assert.deepEqual(groups.map((g) => [g.status, g.n]), [["fail", 1], ["warn", 2], ["ok", 3], ["grey", 1]], "vacuity: the summary counted the mixed set");
  const { el, done } = await mount();
  const lines = [...el.querySelectorAll("[data-group]")];
  assert.deepEqual(lines.map((l) => [l.getAttribute("data-group"), l.getAttribute("data-n")]), [["fail", "1"], ["warn", "2"], ["ok", "3"], ["grey", "1"]]);
  for (const g of groups) {
    const line = el.querySelector(`[data-group="${g.status}"]`)!;
    assert.ok(line.textContent?.startsWith(`${g.n} ${g.words}`), `${g.status}: "${line.textContent}"`);
    if (g.meaning) assert.ok(line.textContent?.includes(g.meaning), `${g.status} says what it asks`);
  }
  await done();
});

test("the groups that need something are buttons to their first row; ok and not-checked are plain", async () => {
  const { el, done } = await mount();
  assert.ok(el.querySelector('[data-group="fail"] button'));
  assert.ok(el.querySelector('[data-group="warn"] button'));
  assert.equal(el.querySelector('[data-group="ok"] button'), null);
  assert.equal(el.querySelector('[data-group="grey"] button'), null);
  // The rows are still listed beneath, each with its status.
  assert.equal(el.querySelectorAll("[data-check]").length, rows.length);
  await done();
});

test("an empty group: its count and words, no meaning line, no button", async () => {
  const saved = view.rows;
  view.rows = [row("d", "ok"), row("e", "ok")];
  try {
    const { el, done } = await mount();
    const fail = el.querySelector('[data-group="fail"]')!;
    assert.equal(fail.getAttribute("data-n"), "0");
    assert.equal(fail.querySelector("button"), null);
    const meaning = (DOCTOR.summary([]) as { status: string; meaning: string }[]).find((g) => g.status === "fail")!.meaning;
    assert.ok(meaning && !fail.textContent?.includes(meaning), "no meaning for a group with no rows");
    await done();
  } finally { view.rows = saved; }
});
