// The ONE place stream-api reads this install's site plugin.
//
// owner/ holds what is the owner's own and not part of the product. The public export drops the
// folder, so a missing folder means "no plugin" — but a folder whose code throws fails the boot,
// loudly, rather than reading as absent. No other file may require ./owner/… —
// tools/check-owner-seam.mjs fails check:all if one does.

'use strict';
const fs = require('fs');
const path = require('path');

/**
 * @param {string} [dir]  the package directory (tests pass a temp one)
 * @returns {null | { id: string, [part: string]: unknown }}
 */
function loadOwnerPlugin(dir = __dirname) {
  const entry = path.join(dir, './owner/index.js');
  if (!fs.existsSync(entry)) return null;
  return require(entry);
}

module.exports = { loadOwnerPlugin };
