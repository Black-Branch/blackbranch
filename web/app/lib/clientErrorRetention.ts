// How long site.client_errors keeps a row. The legal page states this number, so it is read from
// here rather than written twice.
//
// A row goes once its FIRST sighting is older than the retention, even while the error still
// fires: the row carries a page address, a browser string and possibly a signed-in id, and a
// recurring error would otherwise keep them for as long as it recurs. The next report after the
// prune starts a fresh row.

/** Days a client-error row is kept, counted from when the error was first seen. */
export const CLIENT_ERROR_RETENTION_DAYS = 30;

/** The prune statement (POST /api/client-error runs it now and then). */
export const CLIENT_ERROR_PRUNE_SQL =
  `DELETE FROM site.client_errors WHERE first_seen < now() - make_interval(days => ${CLIENT_ERROR_RETENTION_DAYS})`;
