"use client";
// Behavior › Mention sound: watches the chat buffer and plays the viewer's
// chosen sound for a NEW live mention of them. mentionGate.ts decides when;
// mentionSound.ts makes the noise.
//
// Fed from `messages` (the whole buffer), not the rendered rows: while the viewer
// is scrolled up the rendered list is frozen and new lines wait in a queue — a
// mention then must still ping. `mentionsMe` already excludes the viewer's own
// messages (useChatRowDerivations).
import { useEffect, useRef } from "react";
import { createMentionGate } from "./mentionGate";
import { playMentionSound } from "./mentionSound";
import { useSetting } from "./useSetting";
import { chatKey } from "./chatSeed";
import type { ChatMsg } from "./chatMsg";

export function useMentionSound(messages: readonly ChatMsg[], mentionsMe: (m: ChatMsg) => boolean): void {
  const sound = useSetting("chatStyle_mentionSound") ?? "off";
  const gateRef = useRef<ReturnType<typeof createMentionGate> | null>(null);
  useEffect(() => {
    gateRef.current ??= createMentionGate();
    // The gate looks at every change even while the sound is off, so turning it
    // on later does not play for mentions that arrived in the meantime.
    const play = gateRef.current.check(messages.map((m) => ({ key: chatKey(m), live: !!m._anim, alert: mentionsMe(m) })));
    if (play && sound !== "off") playMentionSound(sound);
  }, [messages, mentionsMe, sound]);
}
