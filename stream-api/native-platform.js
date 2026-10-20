'use strict';
// The platform id of the site's OWN chat, accounts and money — what a native message, a site
// account's identity link (stream.links) and a support event paid on the site are stored and sent
// as. The product's word is "native" in every install; the label people see is the site's name.


const NATIVE_PLATFORM = 'native';

/** The id as a SQL list: `platform IN ${NATIVE_SQL}` / `NOT IN`. A constant — never request input. */
const NATIVE_SQL = `('${NATIVE_PLATFORM}')`;

/** Is `p` the site's own platform? */
function isNativePlatform(p) {
  return p === NATIVE_PLATFORM;
}

module.exports = { NATIVE_PLATFORM, NATIVE_SQL, isNativePlatform };
