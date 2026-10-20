// The command tree's plugin commands and the profile card's plugin extras: the site lists, checks
// and runs whatever the plugin adds, in one place, and has nothing extra without a plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../testSource.ts";
import { chatCommands } from "./absent/commands.ts";
import { chatCommandRunners } from "./absent/commandRunners.ts";
import { profileExtras } from "./absent/profile.ts";

const web = join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(web, rel), "utf8");

test("without an owner folder there are no plugin commands, runners or profile extras", () => {
  assert.deepEqual(chatCommands, []);
  assert.deepEqual(chatCommandRunners, {});
  assert.deepEqual(profileExtras, {});
});

test("the tree splices the plugin's commands after the fallback playlist, before emotes", () => {
  const spec = stripComments(read("app/lib/commands/spec.ts"));
  assert.match(spec, /import \{ PLUGIN_COMMANDS \} from "\.\.\/plugins\/commands\.ts";/);
  assert.match(spec, /name: "loop",[\s\S]*?\n  \},\n\s*\.\.\.PLUGIN_COMMANDS,\s*\{\s*name: "emotes"/);
});

test("a plugin leaf passes the same scope and argument checks, then runs the plugin's runner", () => {
  const raw = read("app/lib/commands/run.ts");
  const run = stripComments(raw);
  assert.match(run, /import \{ pluginCommandRunner \} from "\.\.\/plugins\/commandRunners";/);
  const scope = run.indexOf("if (!scopeAllows(viewer, leaf.scope))");
  const missing = run.indexOf("const missing = missingArg(text, p);");
  const plugin = run.indexOf("if (isPluginKey(key)) {");
  assert.ok(scope > 0 && missing > scope && plugin > missing, "the plugin dispatch must come after the scope and argument checks");
  assert.match(run.slice(plugin),
    /const run = pluginCommandRunner\(key\);[\s\S]{0,200}await run\(args, \{ path: p\.pathNames, showNotice, setSendError, modFetch \}\);\s*return \{ kind: "handled" \};/);
  assert.match(raw, /return \{ runCommand \};\s*\}\s*$/, "vacuity anchor: run.ts was read to its end");
});

test("both profile cards show the plugin's descriptor and read, and nothing in their place without one", () => {
  const card = stripComments(read("app/components/UserCard.tsx"));
  assert.match(card, /tierChips\(data, profileDescriptor\(data\)\)/);
  assert.match(card, /pillClasses\(c\.role\)/, "the card colours each pill by its own tone (the plugin's for its pill)");
  assert.match(card, /const read = data\?\.found \? profileRead\(data\) : null;/);
  assert.match(card, /\{read && \(\s*<p className="text-xs text-body-dim italic mt-1\.5 leading-snug">\s*\{read\}/);
  const own = stripComments(read("app/components/ProfileCardBody.tsx"));
  assert.match(own, /\{descriptor && <Pill label=\{descriptor\.label\}>\{descriptor\.value\}<\/Pill>\}/);
  assert.match(own, /\{read && \(\s*<p className="px-4 pt-2 text-xs text-body-dim italic leading-snug">\s*“\{read\}”/);
});
