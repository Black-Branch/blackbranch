// How long the BUNDLED homeserver keeps messages, as its generator configures it: the default
// policy for every room without its own (each DM) in install/matrix/render.sh, and #general's own
// policy in install/matrix/bootstrap.mjs. legalDocument.render.test.ts holds these equal to both
// files. An install whose homeserver is run elsewhere does not state them (legalFactsServer.ts).

/** Days a message is kept in a room without its own policy (every DM). */
export const HOMESERVER_DEFAULT_RETENTION_DAYS = 180;

/** Days a message is kept in #general. */
export const HOMESERVER_GENERAL_RETENTION_DAYS = 30;
