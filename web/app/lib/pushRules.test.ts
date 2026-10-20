// Per-channel notification settings expressed as Matrix push rules.
//
// The fixtures below are rule shapes read from a real Synapse push_rules
// table — Element writes them in the older ["dont_notify"] form, which the
// reader must still understand even though we only ever WRITE the
// empty-actions form.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/pushRules.test.ts

import "./legacyNamespace.setup.test.ts"; // first: this suite pins read-both (a legacy prefix is set)
import test from "node:test";
import assert from "node:assert/strict";
import {
  roomNotifySetting, accountNotificationsOff, ruleOpsFor, muteRuleId,
  type RuleSet,
} from "./pushRules.ts";

const ROOM = "!general:site.test";

const rule = (rule_id: string, actions: unknown[], extra: Record<string, unknown> = {}) =>
  ({ rule_id, enabled: true, actions, ...extra });

/** The owner's real account shape: master ON, message + encrypted silenced. */
const OWNER_ACCOUNT: RuleSet = {
  global: {
    override: [
      rule(".m.rule.master", ["dont_notify"]),
      rule(".m.rule.is_user_mention", ["notify", { set_tweak: "highlight" }]),
    ],
    underride: [rule(".m.rule.message", ["dont_notify"]), rule(".m.rule.encrypted", ["dont_notify"])],
  },
};

/** A default account: master present but disabled, message notifies. */
const PLAIN_ACCOUNT: RuleSet = {
  global: {
    override: [
      { rule_id: ".m.rule.master", enabled: false, actions: ["dont_notify"] },
      rule(".m.rule.is_user_mention", ["notify", { set_tweak: "highlight" }]),
    ],
    underride: [rule(".m.rule.message", ["notify"])],
  },
};

test("no room rule falls back to the account default", () => {
  assert.equal(roomNotifySetting(PLAIN_ACCOUNT, ROOM), "all");
  assert.equal(roomNotifySetting(OWNER_ACCOUNT, ROOM), "mentions");
});

test("a room rule that notifies is 'all'; one that does not is 'mentions'", () => {
  const all: RuleSet = { global: { ...PLAIN_ACCOUNT.global, room: [rule(ROOM, ["notify"])] } };
  const mentions: RuleSet = { global: { ...PLAIN_ACCOUNT.global, room: [rule(ROOM, [])] } };
  assert.equal(roomNotifySetting(all, ROOM), "all");
  assert.equal(roomNotifySetting(mentions, ROOM), "mentions");
});

test("Element's older dont_notify room rule still reads as 'mentions'", () => {
  const legacy: RuleSet = { global: { ...PLAIN_ACCOUNT.global, room: [rule(ROOM, ["dont_notify"])] } };
  assert.equal(roomNotifySetting(legacy, ROOM), "mentions");
});

test("an override mute reads as 'none' EVEN WHEN a room rule also exists", () => {
  // Both kinds can be live at once — another client wrote one, or a switch was
  // interrupted. The stronger one is the one in force, so it must win.
  const both: RuleSet = {
    global: {
      ...PLAIN_ACCOUNT.global,
      override: [
        ...(PLAIN_ACCOUNT.global?.override ?? []),
        rule(muteRuleId(ROOM), [], { conditions: [{ kind: "event_match", key: "room_id", pattern: ROOM }] }),
      ],
      room: [rule(ROOM, ["notify"])],
    },
  };
  assert.equal(roomNotifySetting(both, ROOM), "none");
});

test("a DISABLED rule is not in force", () => {
  const off: RuleSet = {
    global: { ...PLAIN_ACCOUNT.global, room: [{ rule_id: ROOM, enabled: false, actions: [] }] },
  };
  assert.equal(roomNotifySetting(off, ROOM), "all");
});

test("another room's mute does not affect this room", () => {
  const other: RuleSet = {
    global: {
      ...PLAIN_ACCOUNT.global,
      override: [
        ...(PLAIN_ACCOUNT.global?.override ?? []),
        rule(muteRuleId("!other:site.test"), [], {
          conditions: [{ kind: "event_match", key: "room_id", pattern: "!other:site.test" }],
        }),
      ],
    },
  };
  assert.equal(roomNotifySetting(other, ROOM), "all");
});

test("the account master switch is read from the override rule's enabled flag", () => {
  assert.equal(accountNotificationsOff(OWNER_ACCOUNT), true);
  assert.equal(accountNotificationsOff(PLAIN_ACCOUNT), false);
  assert.equal(accountNotificationsOff(undefined), false);
});

test("choosing 'all' writes a room rule that NOTIFIES, and clears any mute", () => {
  const withMute: RuleSet = {
    global: {
      override: [rule(muteRuleId(ROOM), [], { conditions: [{ kind: "event_match", key: "room_id", pattern: ROOM }] })],
    },
  };
  const ops = ruleOpsFor("all", ROOM, withMute);
  assert.deepEqual(ops[0], { op: "delete", kind: "override", ruleId: muteRuleId(ROOM) });
  const add = ops.at(-1);
  assert.equal(add?.op, "add");
  assert.equal(add?.kind, "room");
  assert.deepEqual(add && "body" in add ? add.body.actions : null, ["notify"]);
});

test("a mute written under a FOREIGN rule id is still deleted — matched on condition, not on our id", () => {
  // Another client (Element, or this account on a different device) muted the
  // room under its own rule_id. roomNotifySetting reads it as "none" either
  // way (mutedByOverride matches on condition), so ruleOpsFor must clear it
  // the same way or the room never actually unmutes.
  const foreignMute: RuleSet = {
    global: {
      override: [
        rule("m.rule.some_other_client_id", [], {
          conditions: [{ kind: "event_match", key: "room_id", pattern: ROOM }],
        }),
      ],
    },
  };
  const ops = ruleOpsFor("all", ROOM, foreignMute);
  assert.deepEqual(ops[0], { op: "delete", kind: "override", ruleId: "m.rule.some_other_client_id" });
});

test("a DISABLED mute (any id) is left alone — it is not in force, so there is nothing to clear", () => {
  const disabledMute: RuleSet = {
    global: {
      override: [
        { rule_id: muteRuleId(ROOM), enabled: false, actions: [], conditions: [{ kind: "event_match", key: "room_id", pattern: ROOM }] },
      ],
    },
  };
  const ops = ruleOpsFor("all", ROOM, disabledMute);
  assert.deepEqual(ops.filter((o) => o.op === "delete"), []);
});

test("a mute on a DIFFERENT room is never touched", () => {
  const otherRoomMute: RuleSet = {
    global: {
      override: [
        rule(muteRuleId("!other:site.test"), [], {
          conditions: [{ kind: "event_match", key: "room_id", pattern: "!other:site.test" }],
        }),
      ],
    },
  };
  const ops = ruleOpsFor("all", ROOM, otherRoomMute);
  assert.deepEqual(ops.filter((o) => o.op === "delete"), []);
});

test("choosing 'mentions' writes an EMPTY-action room rule, never dont_notify", () => {
  const ops = ruleOpsFor("mentions", ROOM, PLAIN_ACCOUNT);
  const add = ops.at(-1);
  assert.equal(add?.kind, "room");
  assert.deepEqual(add && "body" in add ? add.body.actions : null, []);
});

test("choosing 'none' writes an OVERRIDE keyed on room_id, above the mention rules", () => {
  const ops = ruleOpsFor("none", ROOM, PLAIN_ACCOUNT);
  const add = ops.at(-1);
  assert.equal(add?.kind, "override");
  assert.equal(add && "ruleId" in add ? add.ruleId : null, muteRuleId(ROOM));
  assert.deepEqual(
    add && "body" in add ? add.body.conditions : null,
    [{ kind: "event_match", key: "room_id", pattern: ROOM }]
  );
});

test("an existing room rule is deleted before a new one is added (SYN-590)", () => {
  const existing: RuleSet = { global: { ...PLAIN_ACCOUNT.global, room: [rule(ROOM, ["notify"])] } };
  const ops = ruleOpsFor("mentions", ROOM, existing);
  assert.deepEqual(ops[0], { op: "delete", kind: "room", ruleId: ROOM });
  assert.equal(ops.at(-1)?.op, "add");
});

test("nothing is deleted that does not exist", () => {
  const ops = ruleOpsFor("all", ROOM, PLAIN_ACCOUNT);
  assert.deepEqual(ops.filter((o) => o.op === "delete"), []);
});

// ── read-both: a mute written under the PRODUCT prefix is ours too ─────────────────────────────
const productMute: RuleSet = {
  global: {
    ...PLAIN_ACCOUNT.global,
    override: [
      ...(PLAIN_ACCOUNT.global?.override ?? []),
      rule(`app.blackbranch.mute.${ROOM}`, [], { conditions: [{ kind: "event_match", key: "room_id", pattern: ROOM }] }),
    ],
  },
};

test("read-both: a product-prefix mute reads as 'none'", () => {
  assert.equal(roomNotifySetting(productMute, ROOM), "none");
});

test("any change deletes the product-prefix mute; 'none' re-adds it under the product id (write-new)", () => {
  for (const setting of ["all", "mentions", "none"] as const) {
    const ops = ruleOpsFor(setting, ROOM, productMute);
    assert.deepEqual(ops[0], { op: "delete", kind: "override", ruleId: `app.blackbranch.mute.${ROOM}` }, setting);
  }
  const add = ruleOpsFor("none", ROOM, productMute).at(-1);
  assert.equal(add && "ruleId" in add ? add.ruleId : null, `app.blackbranch.mute.${ROOM}`);
});
