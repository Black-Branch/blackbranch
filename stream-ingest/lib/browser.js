// The headless browser the YouTube reader (and Kick's one-time chatroom lookup) runs in.
//
// On an image without Chromium — or without the libraries it needs — Playwright's launch throws a
// boxed, many-line message, or (a missing library under some sandboxes) waits out its default
// three-minute launch timeout. Unhandled, the reader fails as "youtube failed to start" with a
// wall of text, or sits `starting`. Here the launch is bounded and a missing browser is said
// in one line that names it, so the Doctor and the Stream tab can show it: "browser missing: …".

import { chromium } from 'playwright';

const LAUNCH_TIMEOUT_MS = 30_000;

// What Playwright says when the browser, or a library it needs, is not there.
const MISSING = /Executable doesn't exist|missing dependencies|error while loading shared libraries|ENOENT|Failed to launch|spawn .* ENOENT|Host system is missing/i;

/** The first line of a launch error that says something (Playwright boxes its advice). */
function firstLine(err) {
  const text = String(err?.message || err || '');
  const line = text.split('\n').map((l) => l.replace(/^[\s║╔╚═]+|[\s║═╗╝]+$/g, '')).find((l) => l && !/^[╔╚═─]+$/.test(l)) || 'unknown error';
  return line.replace(/^browserType\.launch:\s*/, '');
}

/**
 * Pure: the error a failed launch becomes. A missing browser says so first.
 * @param {unknown} err
 * @returns {Error}
 */
export function launchError(err) {
  const text = String(err?.message || err || '');
  const line = firstLine(err);
  if (MISSING.test(text)) return new Error(`browser missing: ${line}`);
  if (/Timeout .*exceeded/i.test(text)) return new Error(`browser did not start within ${LAUNCH_TIMEOUT_MS / 1000}s: ${line}`);
  return new Error(`browser failed to start: ${line}`);
}

/**
 * chromium.launch, bounded, with a one-line error.
 * @param {import('playwright').LaunchOptions} opts
 * @param {{ launcher?: { launch: (o: object) => Promise<any> } }} [deps]
 */
export async function launchBrowser(opts, { launcher = chromium } = {}) {
  try {
    return await launcher.launch({ timeout: LAUNCH_TIMEOUT_MS, ...opts });
  } catch (err) {
    throw launchError(err);
  }
}
