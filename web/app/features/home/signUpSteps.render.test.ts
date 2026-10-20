import "../../lib/testTsx.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stripComments } from "../../lib/testSource.ts";
const { nextShipped, prevShipped, SHIPPED_STEPS } = await import("./SignUpSteps.tsx");

test("the shipped steps are 2, 3 and 5; 4 and 6 are skipped over", () => {
  assert.deepEqual([...SHIPPED_STEPS], [2, 3, 5]);
  assert.equal(nextShipped(2), 3);
  assert.equal(nextShipped(3), 5);
  assert.equal(nextShipped(4), 5);
  assert.equal(nextShipped(5), "done");
  assert.equal(nextShipped(6), "done");
  assert.equal(prevShipped(5), 3);
  assert.equal(prevShipped(3), 2);
  assert.equal(prevShipped(2), null);
});

test("each step is its own view with the account card's own body inside", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { StepView } = await import("./SignUpSteps.tsx");
  const props = { matrixId: "@k:site.test", onNext: () => {}, onBack: () => {}, onSkipAll: () => {} };
  const s2 = renderToStaticMarkup(createElement(StepView, { ...props, step: 2 as const }));
  assert.ok(s2.includes("Link your platforms"));
  assert.ok(s2.includes("Skip setup") && s2.includes(">Next<") && !s2.includes(">Back<"), "step 2 has no Back");
  const s3 = renderToStaticMarkup(createElement(StepView, { ...props, step: 3 as const }));
  assert.ok(s3.includes("Make it yours") && s3.includes(">Back<"));
  const s5 = renderToStaticMarkup(createElement(StepView, { ...props, step: 5 as const }));
  assert.ok(s5.includes("Secure your DMs") && s5.includes("Set up encryption") && s5.includes(">Done<"));
  assert.ok(!s5.includes("Devices &amp; Security"), "the security window opens on tap, not on render");
});

test("step 5 boots the client only on demand, inside a dialog Window, and never statically imports the SDK path", () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), "app/features/home/SignUpSteps.tsx"), "utf8"));
  assert.match(src, /nextDynamic\(\(\) => import\("@\/app\/components\/MatrixSettings"\), \{ ssr: false/);
  // Review Important 3: a dialog portals to <body> and covers the whole phone;
  // the in-pane shape is "panel" (the phone's Home pane registers a
  // WindowLayerTarget), a task panel so the body region behind it is inert.
  // Desktop's dock pane has no target → dialog there, as ForumActionHost does.
  assert.match(src, /useNarrowViewport\(\)/);
  assert.match(src, /<Window presentation=\{narrow \? "panel" : "dialog"\} kind="task"/);
  assert.ok(!/^import .* from "@\/app\/components\/MatrixSettings"/m.test(src), "no static import");
  assert.match(src, /import ProfileEditor from "@\/app\/components\/ProfileEditor"/);
  assert.match(src, /import LinkedAccountsInline from "@\/app\/components\/LinkedAccountsInline"/);
  assert.match(src, /import PresenceStatusPicker from "@\/app\/components\/PresenceStatusPicker"/);
  assert.match(src, /useSignupProgress\(/);
  assert.match(src, /setStep\("done"\)/, "Skip setup writes done");
  assert.ok(!/onClose=\{[^}]*setStep/.test(src), "closing the security window never moves the step");
  assert.ok(src.trimEnd().endsWith("}"), "END anchor");
});

test("HomeView's signed-in slot is the SignedInColumn", () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), "app/features/home/HomeView.tsx"), "utf8"));
  assert.match(src, /<div data-home-left="card" className="min-w-0"><SignedInColumn active=\{active\} \/><\/div>/);
  assert.ok(!src.includes("<OwnCard"), "HomeView no longer mounts OwnCard directly — the column decides");
});
