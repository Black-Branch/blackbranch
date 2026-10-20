'use strict';
// /user/lookup mounted on a stand-in app and pool, for the profile tests here and in owner/.
// (testlib/ is not deployed — see source.js.)
const { registerProfileRoutes } = require('../profiles');

const STATS = { name: 'ann', karma: '0.6', activity: '30', streams: '4', support: '0', is_member: false };

/** @param {Function|null} profileExtras  @param {string|null} [impression] the stand-in's bot_impressions row
 *  @returns {(query: object) => Promise<object|null>} the route's JSON body for a query */
function mountLookup(profileExtras, impression = null) {
  const routes = {};
  const app = { get: (p, _auth, h) => { routes[p] = h; } };
  const pool = {
    query: async (sql) => {
      if (/bot_impressions/.test(sql)) return { rows: impression ? [{ impression }] : [] };
      if (/user_stats/.test(sql)) return { rows: [STATS] };
      return { rows: [] };
    },
  };
  registerProfileRoutes(app, { pool, requireInternal: null, wrap: (f) => f, profileExtras });
  return async (query) => {
    let body = null;
    const res = { status: () => res, json: (b) => { body = b; return res; } };
    await routes['/user/lookup']({ query }, res);
    return body;
  };
}

module.exports = { mountLookup };
