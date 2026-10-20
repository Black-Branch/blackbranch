// Tests for the chat-command handlers' pure logic (gating, parsing, removal guards).
// The timer commands' API path is validated live. Run: node --test lib/commands.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import * as commands from './commands.js';
import { handleDonoCommand, donoLine } from './commands.js';
import { readFile } from 'node:fs/promises';

test('!dono answers with the install\'s support line, and only to !dono', () => {
  const line = () => 'support me at example.tv/tip';
  assert.equal(handleDonoCommand({ message: '!dono' }, line), 'support me at example.tv/tip');
  assert.equal(handleDonoCommand({ message: '!DONO please' }, line), 'support me at example.tv/tip');
  assert.equal(handleDonoCommand({ message: 'just chatting' }, line), null);
});

test('!dono line: money.supportLine wins; unset = this site\'s own tip page, never anyone else\'s links', () => {
  const cfg = (o) => (k) => o[k] ?? null;
  assert.equal(donoLine(cfg({ 'money.supportLine': '  Tips → example.tv  ', 'site.origin': 'https://site.example' })), 'Tips → example.tv');
  assert.equal(donoLine(cfg({ 'site.origin': 'https://site.example/' })), 'support the stream → https://site.example/donate');
  assert.match(donoLine(cfg({})), /^support the stream/);
  // A fresh install's !dono must name no outside service at all.
  for (const o of [{}, { 'site.origin': 'https://site.example' }]) {
    assert.doesNotMatch(donoLine(cfg(o)), /patreon|ko-?fi|streamlabs/i);
  }
});

test('!bully is not a command', () => {
  // It authorized on DISPLAY NAME, which is not an identity — names are
  // per-platform, changeable, and collide across Twitch/YouTube/Kick, so anyone
  // renaming themselves to a mod's handle could issue real Twitch timeouts.
  // A privileged command must gate on canonicalId or a platform mod flag.
  assert.equal(commands.handleBullyCommand, undefined, 'the !bully handler is back');
  assert.equal(commands.isBullied, undefined, 'the bully list is back');
  assert.equal(commands.bullyConfig, undefined, 'the bully config is back');
});

test('mod commands are not handled in platform chat', async () => {
  const src = await readFile(new URL('./commands.js', import.meta.url), 'utf8');
  // LINE comments FIRST. Stripping blocks first fails SILENTLY: a `//` comment
  // containing `/*` reads as an opener to the block regex, and everything down to
  // the next `*/` disappears from the scan, so negative checks pass vacuously
  // over the hole.
  const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Vacuity guard on the END of the file. Four of the six assertions below are
  // NEGATIVE (`!code.includes`), and truncation makes every one of those pass.
  // commands.js ENDS in a comment block, so the anchor is its last real code.
  assert.match(code, /return \/\^!dono\\b\/i\.test/,
    'the commands.js scan lost the end of the file — the "is it gone?" checks below would ' +
    'now pass vacuously');
  for (const gone of [
    'handleTimerCommand', 'handle7tvCommand', 'handle7tvCheckCommand', 'handleGadgetCommand',
  ]) {
    assert.ok(!code.includes(gone), `${gone} is back in platform chat — it belongs on the site now`);
  }
  // The PUBLIC commands must survive: removing them was never the intent.
  for (const kept of ['handleKarmaCommand', 'handlePronounCommand', 'handleDonoCommand']) {
    assert.ok(code.includes(kept), `${kept} was removed — only the MOD commands should have gone`);
  }
});

// ── !rank / !karma answer for the ONE platform identity asked about (review round 5, PB1) ──────
// The lookup used to be asked by bare name across the merged identity and printed the identity's
// preferred name (the SITE name when one is linked): a Twitch `!rank gadget_tw` said "@CaseySite".
// It now always names the asking platform; stream-api answers that one identity (its handle and
// its own figures) unless every account on the person shows its links (stream-api profiles.js).
test('!rank <name> asks for that name ON the platform the command came from', async () => {
  const asked = [];
  const lookup = async (q) => { asked.push(q); return { scope: 'identity', name: 'gadget_tw', activity: 3, streams: 2, isMember: true }; };
  const reply = await commands.handleKarmaCommand({ message: '!rank @gadget_tw', platform: 'twitch', username: 'asker', canonicalId: 'c-asker' }, { lookup });
  assert.deepEqual(asked, [{ platform: 'twitch', username: 'gadget_tw' }]);
  assert.equal(reply, '@gadget_tw — 3 messages · 2 streams · Member');
});

test('bare !rank asks for the sender\'s own identity on this platform, and prints the answer\'s handle', async () => {
  const asked = [];
  const lookup = async (q) => { asked.push(q); return { scope: 'identity', name: 'gadget_tw', activity: 1, streams: 1, isMember: false }; };
  assert.equal(await commands.handleKarmaCommand({ message: '!karma', platform: 'twitch', username: 'gadget_tw', userId: 'tw-1', canonicalId: 'c1' }, { lookup }), '@gadget_tw — 1 message · 1 stream');
  await commands.handleKarmaCommand({ message: '!karma', platform: 'kick', username: 'k_name', userId: 'k-1' }, { lookup });
  await commands.handleKarmaCommand({ message: '!karma', platform: 'kick', username: 'k_name' }, { lookup });
  assert.deepEqual(asked, [
    { platform: 'twitch', canonicalId: 'c1', username: 'gadget_tw' },
    { platform: 'kick', userId: 'k-1', username: 'k_name' },
    { platform: 'kick', username: 'k_name' },
  ]);
});

test('a lookup is never asked without a platform (a bare-name lookup is the merged identity)', async () => {
  let asked = 0;
  const lookup = async () => { asked++; return { name: 'x' }; };
  assert.equal(await commands.handleKarmaCommand({ message: '!rank someone', username: 'asker' }, { lookup }), null);
  // Nor for oneself without the handle (stream-api answers one account, keyed by its handle).
  assert.equal(await commands.handleKarmaCommand({ message: '!rank', platform: 'twitch', canonicalId: 'c1' }, { lookup }), null);
  assert.equal(asked, 0);
});

test('a merged answer (the person shows their links) keeps the scoring labels and the preferred name', async () => {
  const lookup = async () => ({ scope: 'merged', name: 'CaseySite', temperamentLabel: 'Warm', labelRank: 4, intelligenceTier: 'Smart', regularityTier: 'Constant', wordCountTier: 'Writer', supportTier: 'Patron' });
  assert.equal(await commands.handleKarmaCommand({ message: '!rank gadget_tw', platform: 'twitch' }, { lookup }),
    '@CaseySite — Warm (4th) · Smart · Constant · Writer · Patron');
});

test('no record: 404 answers with the name as typed; a bare !rank stays silent', async () => {
  const lookup = async () => { throw new Error('stream-api GET /user/lookup -> 404 {}'); };
  assert.equal(await commands.handleKarmaCommand({ message: '!rank CaseySite', platform: 'twitch' }, { lookup }), '@CaseySite has no record yet.');
  assert.equal(await commands.handleKarmaCommand({ message: '!rank', platform: 'twitch', username: 'me', canonicalId: 'c1' }, { lookup }), null);
});
