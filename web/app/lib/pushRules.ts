// Per-channel notification settings, expressed as Matrix push rules.
//
// Matrix evaluates rules by class, highest first:
//   override → content → room → sender → underride
// The three settings are three different HEIGHTS in that order, and the height
// IS the behaviour:
//
//   all       room-kind rule, actions ["notify"]   — beats the .m.rule.message
//                                                    underride, so it notifies
//                                                    even on an account whose
//                                                    global default is silent
//   mentions  room-kind rule, actions []           — kills the message underride
//                                                    while .m.rule.is_user_mention
//                                                    (an OVERRIDE) still fires
//   none      override rule on room_id, actions [] — above the mention rules too
//
// client.setRoomMutePushRule() is NOT used anywhere. Despite its name it
// writes a room-kind dont_notify rule — this file's "mentions", not its "none".
// Using it would leave mentions ringing in a channel the user muted.
//
// We WRITE actions as [] (the spec's form since Matrix 1.7). We READ
// ["dont_notify"] as equivalent, because Element writes rules in that older
// form.

import { MUTE_RULE } from "./matrixNamespace.ts";

export type NotifySetting = "all" | "mentions" | "none";

export type Rule = {
  rule_id: string;
  enabled: boolean;
  actions: unknown[];
  conditions?: { kind: string; key?: string; pattern?: string }[];
};

export type RuleSet = {
  global?: { override?: Rule[]; room?: Rule[]; underride?: Rule[] };
};

const MASTER = ".m.rule.master";
const MESSAGE = ".m.rule.message";

/** Our own mute rules are namespaced (MUTE_RULE, matrixNamespace.ts) so they are
 *  recognisably ours and can never collide with a server-default id. Nothing reads
 *  the id back: a mute is recognised and deleted by its `room_id` CONDITION (below),
 *  so a rule under either namespace — or another client's id — reads as "none" and
 *  is replaced by any change.
 *  @test-only `ruleOpsFor` builds this id internally in this same file, which
 *  the orphan scanner deliberately does not count as a reference; the tests
 *  are the genuine consumer — they reconstruct the wire-format rule id to
 *  build fixtures. */
export function muteRuleId(roomId: string): string {
  return `${MUTE_RULE.write}.${roomId}`;
}

function notifies(actions: unknown[]): boolean {
  if (actions.length === 0) return false;
  if (actions.includes("dont_notify")) return false;
  return actions.includes("notify");
}

function live(rules: Rule[] | undefined, id: string): Rule | undefined {
  return rules?.find((r) => r.rule_id === id && r.enabled);
}

/** An enabled override that silences exactly this room — ours or another
 *  client's, matched on the condition rather than on our own rule id. */
function mutedByOverride(rules: RuleSet | undefined, roomId: string): boolean {
  return (rules?.global?.override ?? []).some(
    (r) =>
      r.enabled &&
      !notifies(r.actions) &&
      (r.conditions ?? []).some((c) => c.kind === "event_match" && c.key === "room_id" && c.pattern === roomId)
  );
}

/**
 * What this room is set to right now.
 *
 * The override is checked FIRST: both kinds can be live at once (another client
 * wrote one, or a switch was interrupted mid-way), and the one higher in the
 * evaluation order is the one actually in force.
 */
export function roomNotifySetting(rules: RuleSet | undefined, roomId: string): NotifySetting {
  if (mutedByOverride(rules, roomId)) return "none";
  const roomRule = live(rules?.global?.room, roomId);
  if (roomRule) return notifies(roomRule.actions) ? "all" : "mentions";
  // No room rule: the account's own default decides what the reader is told.
  const message = live(rules?.global?.underride, MESSAGE);
  return message && !notifies(message.actions) ? "mentions" : "all";
}

/** The account-wide switch. When it is on, no per-room rule can notify. */
export function accountNotificationsOff(rules: RuleSet | undefined): boolean {
  return !!live(rules?.global?.override, MASTER);
}

export type RuleOp =
  | { op: "delete"; kind: "override" | "room"; ruleId: string }
  | { op: "add"; kind: "override" | "room"; ruleId: string; body: { actions: unknown[]; conditions?: unknown[] } };

/**
 * The writes that move this room to `setting`.
 *
 * Deletes come first and cover BOTH kinds, so the two can never both be live
 * for one room — and because Synapse rejects an update of an existing rule in
 * place (SYN-590), which is why matrix-js-sdk's own mute helper deletes first
 * too.
 *
 * The mute delete matches on CONDITION (an enabled override carrying a
 * `room_id` condition for this room), not on our own rule id. A mute another
 * client wrote (Element, or this same account on a different device) carries
 * a different `rule_id` but the same `room_id` condition, and
 * `roomNotifySetting` reads it as "none" regardless of whose id it is.
 * Deleting only `muteRuleId(roomId)` would leave a foreign-id mute live
 * forever: choosing "All messages" would add a notifying room rule while the
 * override above it kept silencing the room, so the tick would move but the
 * channel would never actually unmute.
 *
 * This does NOT mirror `mutedByOverride` above — that also requires
 * `!notifies(r.actions)`, so it only counts a NON-notifying override as a
 * mute. The filter here is deliberately broader: it deletes any enabled
 * override keyed on this room's `room_id`, notifying or not. That costs
 * nothing in practice — Matrix's override class exists to silence, never to
 * force-notify a single room, so no real rule keys on `room_id` while
 * notifying — and it is simpler than replicating `mutedByOverride`'s extra
 * check for a case that does not occur.
 */
export function ruleOpsFor(setting: NotifySetting, roomId: string, rules: RuleSet | undefined): RuleOp[] {
  const ops: RuleOp[] = [];
  const mutes = (rules?.global?.override ?? []).filter(
    (r) =>
      r.enabled &&
      (r.conditions ?? []).some((c) => c.kind === "event_match" && c.key === "room_id" && c.pattern === roomId)
  );
  for (const m of mutes) ops.push({ op: "delete", kind: "override", ruleId: m.rule_id });
  const roomRule = (rules?.global?.room ?? []).find((r) => r.rule_id === roomId);
  if (roomRule) ops.push({ op: "delete", kind: "room", ruleId: roomId });

  if (setting === "none") {
    ops.push({
      op: "add",
      kind: "override",
      ruleId: muteRuleId(roomId),
      body: { actions: [], conditions: [{ kind: "event_match", key: "room_id", pattern: roomId }] },
    });
  } else {
    ops.push({
      op: "add",
      kind: "room",
      ruleId: roomId,
      body: { actions: setting === "all" ? ["notify"] : [] },
    });
  }
  return ops;
}
