// How long automod's held rows are kept, as stream-api/automod.js prunes them
// (AUTOMOD_HELD_RETENTION_DAYS there: every site.automod_held row is deleted that many days after it
// was held, whatever its status). legalDocument.render.test.ts holds this equal to that constant.

/** Days a held message's record (its text and the verdict) is kept, from when it was held. */
export const AUTOMOD_HELD_RETENTION_DAYS = 30;
