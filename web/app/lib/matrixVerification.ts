// matrix-js-sdk crypto-api VerificationPhase numeric values. Shared so the
// verification phase numbers aren't hand-duplicated across MatrixClientContext
// and useMatrixSettings.
//   Unsent=1, Requested=2, Ready=3, Started=4, Cancelled=5, Done=6
export const PHASE_READY = 3;
export const PHASE_CANCELLED = 5;
export const PHASE_DONE = 6;
