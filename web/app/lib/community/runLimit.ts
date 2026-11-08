// The longest a community reconciler run may go: its unit's TimeoutStartSec
// (install/systemd/blackbranch-community@.service). A run's row is written when it starts and filled when
// it ends; one still unfinished after this crashed. Read by the delete guard (communityAdmin.ts) and the
// Runs card, so both call the same row stale.
export const RUN_LIMIT_MS = 20 * 60_000;
