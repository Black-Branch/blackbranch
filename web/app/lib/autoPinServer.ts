// The crowd auto-pin settings as this process holds them now (Admin Panel › Site › Auto-pin).
// SERVER ONLY. Read at call time, so a change applies at the next vote.
import { instanceResolve } from "./instanceConfigServer.ts";
import { autoPinRulesFrom, type AutoPinRules } from "./votePolicy.ts";

export function autoPinRules(): AutoPinRules {
  return autoPinRulesFrom((key) => instanceResolve(key).value);
}
