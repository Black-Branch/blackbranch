// The on-device diagnostic URL switches (?kbdebug, ?backdebug, ?playerdebug, ?chipdebug) are for
// whoever is chasing a defect on a phone. A development build has them; a production build has them
// only when it was built with NEXT_PUBLIC_DEBUG_FLAGS=1. Next inlines both values at build time, so
// a production build without the switch carries the diagnostics as dead code.

/** Are the debug switches mounted in a build with these values?
 *  @test-only debugFlags.test.ts drives every build case; DEBUG_FLAGS_ON below is its runtime caller. */
export function debugFlagsOn(env: { NODE_ENV?: string; NEXT_PUBLIC_DEBUG_FLAGS?: string }): boolean {
  return env.NODE_ENV !== "production" || env.NEXT_PUBLIC_DEBUG_FLAGS === "1";
}

/** This build's answer — every switch reads it before it reads the URL. */
export const DEBUG_FLAGS_ON = debugFlagsOn({ NODE_ENV: process.env.NODE_ENV, NEXT_PUBLIC_DEBUG_FLAGS: process.env.NEXT_PUBLIC_DEBUG_FLAGS });
