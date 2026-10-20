// Low power (settings → Effects). It flips the SAME switches a viewer
// can flip by hand — no hidden override layer — and remembers which were on so
// turning it off puts them back. Pure: node --test imports it.

// @test-only the list itself has no production importer — lowPowerOn/Off/State
// (this file's real exports, wired into ChatSettings.tsx) close over it
// internally; lowPower.test.ts's all() helper is the one consumer that needs
// the raw key list rather than the functions built on it.
export const LOW_POWER_KEYS = [
  "animEmotesOn", "piCycle", "unAnim", "shadowOn", "seamOn", "chatFade", "transparencyOn", "glassOn",
] as const;

type Vals = Record<string, unknown>;

export function lowPowerOn(v: Vals): Vals {
  const wasOn = LOW_POWER_KEYS.filter((k) => v[k] === true);
  const out: Vals = { lowPower: true, lowPowerPrev: wasOn.join(",") };
  for (const k of LOW_POWER_KEYS) out[k] = false;
  return out;
}

export function lowPowerOff(v: Vals): Vals {
  const out: Vals = { lowPower: false, lowPowerPrev: "" };
  const prev = String(v.lowPowerPrev ?? "").split(",").filter(Boolean);
  for (const k of prev) if ((LOW_POWER_KEYS as readonly string[]).includes(k)) out[k] = true;
  return out;
}

export function lowPowerState(v: Vals): "off" | "on" | "some" {
  if (v.lowPower !== true) return "off";
  return LOW_POWER_KEYS.some((k) => v[k] === true) ? "some" : "on";
}
