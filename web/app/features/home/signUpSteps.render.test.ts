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

test("no platform configured: 'Link your platforms' is skipped — the walk is Make it yours → Secure your DMs, 1 of 2, no Back", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { StepView, stepsFor } = await import("./SignUpSteps.tsx");
  const none = stepsFor(false);
  assert.deepEqual([...none], [3, 5]);
  assert.equal(nextShipped(2, none), 3, "a stored step 2 moves on to 3");
  assert.equal(nextShipped(3, none), 5);
  assert.equal(prevShipped(3, none), null, "the first step has no Back");
  assert.equal(prevShipped(5, none), 3);
  const props = { matrixId: "@k:site.test", onNext: () => {}, onBack: () => {}, onSkipAll: () => {}, steps: none };
  const s3 = renderToStaticMarkup(createElement(StepView, { ...props, step: 3 as const }));
  assert.ok(s3.includes("Make it yours") && s3.includes("Step 1 of 2") && !s3.includes(">Back<"), "vacuity + count + no Back");
  assert.ok(!s3.includes("Link your platforms"));
  const s5 = renderToStaticMarkup(createElement(StepView, { ...props, step: 5 as const }));
  assert.ok(s5.includes("Step 2 of 2") && s5.includes(">Back<"));
});

test("a platform configured: the walk keeps 'Link your platforms' first, 1 of 3", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { StepView, stepsFor } = await import("./SignUpSteps.tsx");
  const some = stepsFor(true);
  assert.deepEqual([...some], [2, 3, 5]);
  const s2 = renderToStaticMarkup(createElement(StepView, { matrixId: "@k:site.test", onNext: () => {}, onBack: () => {}, onSkipAll: () => {}, steps: some, step: 2 as const }));
  assert.ok(s2.includes("Link your platforms") && s2.includes("Step 1 of 3") && !s2.includes(">Back<"));
  // The column asks the account panel's own route, and step 2 never flashes before the answer.
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), "app/features/home/SignUpSteps.tsx"), "utf8"));
  assert.match(src, /getJson<[^>]*>\("\/api\/account-links"/);
  assert.match(src, /if \(platforms === undefined && shownStep\(step \?\? 2, SHIPPED_STEPS\) === 2\) return null;/);
  assert.match(src, /const steps = stepsFor\(platforms !== false\);/);
  assert.ok(src.trimEnd().endsWith("}"), "END anchor");
});

test("step 5 on a device the sign-in pop-up already set up: says it is done, never asks for encryption setup again", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { StepView } = await import("./SignUpSteps.tsx");
  const props = { matrixId: "@k:site.test", onNext: () => {}, onBack: () => {}, onSkipAll: () => {}, step: 5 as const };
  const ready = renderToStaticMarkup(createElement(StepView, { ...props, encryptionReady: true }));
  assert.ok(ready.includes("Secure your DMs") && ready.includes(">Done<"), "vacuity: step 5 rendered");
  assert.match(ready, /data-encryption-ready/);
  assert.match(ready, /Encryption is already set up on this device/);
  assert.ok(!ready.includes("Set up encryption"), "no second setup prompt");
  const notYet = renderToStaticMarkup(createElement(StepView, { ...props, encryptionReady: false }));
  assert.ok(notYet.includes("Set up encryption") && !notYet.includes("data-encryption-ready"));
  // The column feeds it the device's own verdict.
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), "app/features/home/SignUpSteps.tsx"), "utf8"));
  assert.match(src, /const \{ verdict \} = useEncryptionStatus\(\);/);
  assert.match(src, /encryptionReady=\{verdict === "green"\}/);
  assert.ok(src.trimEnd().endsWith("}"), "END anchor");
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
