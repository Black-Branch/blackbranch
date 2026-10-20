// Review round 5, F3 / L14: no donor or viewer NAME in a journal line on the money and identity
// paths. A first donation printed "[API] New user: <name>", YouTube's alert lines printed
// "from <name>", and an unrecognised gift banner was logged raw (it carries the gifter's name).
// Ids, amounts and platforms identify an event well enough to reconcile it; a name is personal
// data the journal keeps for months.
//
// A source scan: every console.log/warn/error/info/debug/trace call's ARGUMENTS in the files below, string literal
// text removed (a word inside a sentence is prose, not a value), must name no identifier that holds
// a person's name. Vacuity anchors: a minimum count of calls per file, and the scanner must reach
// the file's last console call.
//
// Round 7: a name test that looks for NAME identifiers cannot see a raw dump. Kick's money line
// printed `JSON.stringify(d).slice(0, 400)` — the subscriber, the gifter and every giftee — and
// passed, because `d` is not called "username". So in the ingest adapters, lib/pipeline.js and
// lib/alerts.js a console argument that serialises anything (`JSON.stringify(`, `String(`) or
// hands over a whole payload (`${data}`, `, payload`) fails too. Log the event's id and
// `payloadShape()` (stream-ingest lib/logShape.js: id + top-level keys) instead. A dump that is
// genuinely value-free is allowed by a `// log-names: allow — <why>` comment on the call's own
// line, and every allowance honoured is printed, so a reviewer sees each one.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILES = {
  'stream-api/alert.js': 10,
  'stream-api/identity.js': 5,
  'stream-api/webhooks.js': 5,
  'stream-ingest/platforms/youtube.js': 45,
  'stream-ingest/platforms/twitch.js': 10,
  'stream-ingest/platforms/kick.js': 26,
  'stream-ingest/platforms/streamplace.js': 8,
  'stream-ingest/lib/alerts.js': 3,
  'stream-ingest/lib/pipeline.js': 8,
};
// The raw-dump rule's scope (round 7): the ingest side, where a raw platform payload is in hand.
const DUMP_SCOPE = (rel) => rel.startsWith('stream-ingest/platforms/')
  || rel === 'stream-ingest/lib/pipeline.js' || rel === 'stream-ingest/lib/alerts.js';
// Review round 6, L-1: Twitch's and Kick's alert lines still printed "from <name>" because the
// list above named only YouTube. Every platform adapter is scanned now, found by listing the
// folder, so a platform added later is covered without anyone remembering this file.
const PLATFORM_DIR = 'stream-ingest/platforms';
const platformFiles = fs.readdirSync(path.join(ROOT, PLATFORM_DIR))
  .filter((f) => f.endsWith('.js') && !/\.test\./.test(f)).map((f) => `${PLATFORM_DIR}/${f}`);
for (const f of platformFiles) if (!(f in FILES)) FILES[f] = 1;
// `primary`: a YouTube banner's raw text, which starts with the gifter's name when the author is missing.
const NAME_IDENT = /\b(username|userName|author|displayName|display_name|donorName|gifterName|name|primary)\b/;
// A serialised value or a whole payload handed to the journal. Literal text is already gone from
// `args`, so a word in prose cannot trip it; `.String(` (a method of that name) is not a dump.
const PAYLOAD_IDENT = '(?:data|payload|body|raw|d|obj|frame)';
const RAW_DUMP = new RegExp(String.raw`\bJSON\.stringify\s*\(|(?<![\w.$])String\s*\(`
  + String.raw`|\$\{\s*${PAYLOAD_IDENT}\s*\}|(?:^|,)\s*${PAYLOAD_IDENT}\s*(?:,|$)`);
const ALLOW = /\/\/\s*log-names:\s*allow\s*[—-]+\s*\S/;

/** Each console call's argument text (balanced parens), with the line it starts on. */
function consoleCalls(src) {
  const out = [];
  const re = /console\.(log|warn|error|info|debug|trace)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    let depth = 1;
    let quote = null;
    let tmplDepth = [];
    let args = '';
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (quote === '`' && c === '$' && src[i + 1] === '{') { tmplDepth.push(depth); quote = null; args += '${'; i++; depth++; continue; }
        if (c === quote) quote = null;
        continue; // literal text is prose — dropped
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; args += c + c; continue; }
      if (c === '(' || c === '{' || c === '[') depth++;
      if (c === ')' || c === '}' || c === ']') {
        depth--;
        if (c === '}' && tmplDepth.length && tmplDepth[tmplDepth.length - 1] === depth) { tmplDepth.pop(); quote = '`'; args += '}'; continue; }
      }
      if (depth > 0) args += c;
    }
    out.push({ line: src.slice(0, m.index).split('\n').length, args });
  }
  return out;
}

test('the scanner itself: it sees an interpolated name and ignores the word in prose', () => {
  const calls = consoleCalls("console.log(`[x] New user: ${username} (${platform})`); console.warn('a name is prose', id);");
  assert.equal(calls.length, 2);
  assert.match(calls[0].args, NAME_IDENT);
  assert.doesNotMatch(calls[1].args, NAME_IDENT);
  assert.match(consoleCalls("console.warn('[y] from %s', alert.username)")[0].args, NAME_IDENT);
  assert.match(consoleCalls('console.warn(`[z] banner: "${String(evt.primary || \'\')}"`)')[0].args, NAME_IDENT);
  // console.info / debug / trace reach the journal too (lib/alerts.js logs with console.info).
  assert.match(consoleCalls('console.info(`[k] alert from ${alert.username}`)')[0].args, NAME_IDENT);
  assert.equal(consoleCalls('console.debug(a); console.trace(b);').length, 2);
});

/** The calls in `src` that dump a raw value, split into failures and honoured allowances. */
function rawDumps(src, rel = 'src') {
  const lines = src.split('\n');
  const bad = [];
  const allowed = [];
  for (const c of consoleCalls(src)) {
    if (!RAW_DUMP.test(c.args)) continue;
    const where = `${rel}:${c.line}  ${c.args.trim().slice(0, 120)}`;
    if (ALLOW.test(lines[c.line - 1] || '')) allowed.push(`${where}\n      ${lines[c.line - 1].slice(lines[c.line - 1].indexOf('//')).trim()}`);
    else bad.push(where);
  }
  return { bad, allowed };
}

test('the raw-dump rule itself: a serialised payload is caught, an id and the keys are not', () => {
  const caught = (code) => rawDumps(code).bad.length;
  assert.equal(caught('console.log(JSON.stringify(x));'), 1, 'JSON.stringify of anything');
  assert.equal(caught("console.log(`[k] ${JSON.stringify(d).slice(0, 400)}`);"), 1, 'the Kick money line as it was');
  assert.equal(caught("console.log(`[k] unbound: ${String(data).slice(0, 200)}`);"), 1, 'String() of anything');
  assert.equal(caught('console.log(`[k] frame ${data}`);'), 1, 'a bare payload interpolated');
  assert.equal(caught("console.warn('[k] frame', payload);"), 1, 'a bare payload as an argument');
  assert.equal(caught("console.warn('[k] frame', payload, e.message);"), 1, 'a bare payload among others');
  assert.equal(caught('console.log(`[k] ${event} id=${d.id ?? \'?\'} ${payloadShape(d)}`);'), 0, 'id + shape is the fix');
  assert.equal(caught("console.log('JSON.stringify(x) and String(y) in prose');"), 0, 'prose is not a dump');
  assert.equal(caught('console.log(`n=${data.length}`);'), 0, 'a property of the payload is not the payload');
  // An allowance needs the comment on the call's own line, with a reason.
  const ok = rawDumps('console.log(JSON.stringify(t)); // log-names: allow — tag values only', 'x.js');
  assert.deepEqual([ok.bad.length, ok.allowed.length], [0, 1]);
  assert.equal(rawDumps('console.log(JSON.stringify(t)); // log-names: allow').bad.length, 1, 'no reason, no allowance');
  assert.equal(rawDumps('// log-names: allow — above\nconsole.log(JSON.stringify(t));').bad.length, 1, 'the line above does not count');
});

test('every platform adapter is in the scan (L-1: twitch.js and kick.js were left out)', () => {
  for (const f of ['stream-ingest/platforms/twitch.js', 'stream-ingest/platforms/kick.js', 'stream-ingest/platforms/youtube.js', 'stream-ingest/platforms/streamplace.js']) {
    assert.ok(f in FILES, `${f} is not scanned`);
  }
  assert.ok(platformFiles.length >= 4, `vacuity: only ${platformFiles.length} platform files listed`);
});

for (const [rel, min] of Object.entries(FILES)) {
  test(`no person's name in a journal line: ${rel}`, () => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const calls = consoleCalls(src);
    assert.ok(calls.length >= min, `${rel}: only ${calls.length} console calls found — the scan would be vacuous`);
    const last = src.lastIndexOf('console.');
    assert.ok(last < 0 || calls[calls.length - 1].line === src.slice(0, last).split('\n').length,
      `${rel}: the scan stopped before the file's last console call`);
    // A value passed through the masker (stream-ingest lib/alerts.js maskBannerName) is not a name.
    const named = calls.filter((c) => NAME_IDENT.test(c.args.replace(/maskBannerName\([^)]*\)/g, ''))).map((c) => `${rel}:${c.line}  ${c.args.trim().slice(0, 120)}`);
    assert.deepEqual(named, []);
  });
}

for (const rel of Object.keys(FILES).filter(DUMP_SCOPE)) {
  test(`no raw payload dump in a journal line: ${rel}`, (t) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const { bad, allowed } = rawDumps(src, rel);
    for (const a of allowed) t.diagnostic(`allowed: ${a}`);
    assert.deepEqual(bad, []);
  });
}

test('the raw-dump rule covers the ingest adapters, pipeline.js and alerts.js', () => {
  const scoped = Object.keys(FILES).filter(DUMP_SCOPE);
  for (const f of [...platformFiles, 'stream-ingest/lib/pipeline.js', 'stream-ingest/lib/alerts.js']) {
    assert.ok(scoped.includes(f), `${f} is not in the raw-dump scope`);
  }
  assert.equal(scoped.length, platformFiles.length + 2, `scope drifted: ${scoped.join(', ')}`);
});
