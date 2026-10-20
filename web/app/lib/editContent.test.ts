// Tests for the shared m.replace edit payload + room actions.
//
// Timeline and ThreadPanel share handleReact, handleUnreact, handleDelete,
// eventKey and the edit-content construction; separate copies in each panel
// drift apart.
//
// The edit payload is the risky half. The "* " prefixes are the spec's fallback
// rendering for clients that don't understand edits, and they are easy to get
// subtly wrong: they belong on the OUTER body/formatted_body and must NEVER be
// applied to m.new_content, or edit-aware clients render a literal asterisk on
// the message forever, permanently, with no way for the user to remove it.
//
// The policy is mirrored here because buildMatrixMessage.ts imports ./emoteRes
// with an extensionless specifier, which node --test cannot resolve; the static
// guards at the bottom pin that both panels use the real shared code.
//
// Run: node --test app/lib/editContent.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Content = { msgtype: string; body: string; format?: string; formatted_body?: string };

function buildEditContent(
  built: Content,
  targetEventId: string
): Record<string, unknown> {
  const editContent: Record<string, unknown> = {
    msgtype: "m.text",
    body: "* " + built.body,
    "m.new_content": built,
    "m.relates_to": { rel_type: "m.replace", event_id: targetEventId },
  };
  if (built.format && built.formatted_body) {
    editContent.format = built.format;
    editContent.formatted_body = "* " + built.formatted_body;
  }
  return editContent;
}

const plain = (body: string): Content => ({ msgtype: "m.text", body });
const rich = (body: string, html: string): Content => ({
  msgtype: "m.text", body, format: "org.matrix.custom.html", formatted_body: html,
});

test("the outer body carries the '* ' fallback prefix", () => {
  const c = buildEditContent(plain("hello"), "$1");
  assert.equal(c.body, "* hello");
});

test("THE TRAP: m.new_content must NOT be prefixed", () => {
  // Getting this wrong puts a literal asterisk on the message permanently for
  // every edit-aware client, with no user-facing way to remove it.
  const c = buildEditContent(plain("hello"), "$1");
  assert.equal((c["m.new_content"] as Content).body, "hello");
});

test("the relation points at the edited event", () => {
  const c = buildEditContent(plain("x"), "$abc");
  assert.deepEqual(c["m.relates_to"], { rel_type: "m.replace", event_id: "$abc" });
});

test("formatted_body is prefixed too, but only when BOTH html fields exist", () => {
  const c = buildEditContent(rich("hi", "<b>hi</b>"), "$1");
  assert.equal(c.format, "org.matrix.custom.html");
  assert.equal(c.formatted_body, "* <b>hi</b>");
  assert.equal((c["m.new_content"] as Content).formatted_body, "<b>hi</b>", "new_content stays clean");
});

test("a plain-text edit emits no format fields at all", () => {
  const c = buildEditContent(plain("hi"), "$1");
  assert.equal("format" in c, false);
  assert.equal("formatted_body" in c, false);
});

test("format without formatted_body is ignored rather than half-emitted", () => {
  const c = buildEditContent({ msgtype: "m.text", body: "hi", format: "org.matrix.custom.html" }, "$1");
  assert.equal("format" in c, false, "a format with no body would render as broken markup");
});

test("the outer msgtype is m.text regardless of the built content", () => {
  const c = buildEditContent({ msgtype: "m.notice", body: "hi" }, "$1");
  assert.equal(c.msgtype, "m.text");
});

// ── the shipped code must actually share this ────────────────────────────────

const COMMUNITY = join(process.cwd(), "app", "features", "community");
const read = (f: string) => readFileSync(join(COMMUNITY, f), "utf8");

// useMatrixEditComposer is the ONE call site for buildEditContent: the hook
// builds the payload, and both panels go through the hook.
test("useMatrixEditComposer builds the edit payload through buildEditContent", () => {
  const s = read("useMatrixEditComposer.ts");
  assert.match(s, /buildEditContent\(body, emotes, targetId \?\? "", mentions\)/,
    "the hook constructs the edit payload inline again");
  assert.doesNotMatch(s, /"m\.new_content": newContent/,
    "the hand-rolled edit payload is back — the '* ' prefix rules can now drift");
});

for (const f of ["Timeline.tsx", "ThreadPanel.tsx"]) {
  test(`${f} sends edits through the shared hook, not its own payload`, () => {
    const s = read(f);
    assert.match(s, /useMatrixEditComposer\(\{/,
      "this panel no longer uses the shared edit composer");
    assert.match(s, /await sendEdit\(capturedEdit, body\)/,
      "this panel no longer routes its edit send through the hook");
    assert.doesNotMatch(s, /buildEditContent\(/,
      "this panel constructs an edit payload beside the hook again — the copies can drift");
  });

  test(`${f} gets react/unreact/delete from useRoomActions`, () => {
    const s = read(f);
    assert.match(s, /const \{ handleReact, handleUnreact, handleDelete \} = useRoomActions\(client, room\)/,
      "this panel re-declares the room action handlers");
    assert.doesNotMatch(s, /const handleReact = useCallback\(/, "handleReact was pasted back in");
    assert.doesNotMatch(s, /const handleDelete = useCallback\(/, "handleDelete was pasted back in");
  });

  test(`${f} imports the shared eventKey rather than redefining it`, () => {
    const s = read(f);
    assert.doesNotMatch(s, /const eventKey = \(ev: MatrixEvent\)/, "eventKey was redefined locally");
    assert.match(s, /import \{ useRoomActions, eventKey \}/, "eventKey is no longer imported");
  });
}

test("the shared hook keeps its callbacks memo-stable", () => {
  // MatrixMessageRow's comparator checks these by identity. A finer-grained dep
  // re-renders every row in the window on every event.
  // Comments stripped first: the hook's own doc comment names [client, room]
  // in prose, which would otherwise be counted as a dep array.
  const src = readFileSync(join(process.cwd(), "app", "lib", "useRoomActions.ts"), "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  const deps = src.match(/\[client, room\]/g) ?? [];
  assert.equal(deps.length, 3,
    `expected all 3 handlers to depend on exactly [client, room], found ${deps.length}`);
});
