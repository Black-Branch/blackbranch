// A trailing-debounce writer with an explicit flush.
//
// A plain `setTimeout` + `clearTimeout` pair silently LOSES data: a panel that
// schedules its geometry save on a trailing debounce, flushes nothing on
// pointer-up, and clears the pending timer on unmount discards the move the
// user just made whenever they close or navigate inside the debounce window
// (drag the profile card, open Chat appearance immediately, reopen — old
// position). `flush()` is the fix, and the reason this is a module rather than
// three lines inline: "cancel" and "flush" look interchangeable at a call site
// and are not, so the distinction deserves a name and a test.
//
// Dependency-free (no DOM, no localStorage) so it runs under node --test — the
// same split as panelGeometry.ts vs panelGeometryStore.ts.

type DebouncedPersister<T> = {
  /** Queue `value`, replacing any still-pending one. Resets the delay. */
  schedule(value: T): void;
  /** Write a pending value NOW. No-op when nothing is pending. */
  flush(): void;
  /** Drop a pending value WITHOUT writing it. Use only when the value is
   *  genuinely unwanted — on unmount you almost always want flush(). */
  cancel(): void;
  /** Testing/diagnostics: is a write still queued? */
  isPending(): boolean;
};

export function createDebouncedPersister<T>(
  write: (value: T) => void,
  delayMs: number
): DebouncedPersister<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Boxed rather than a bare `T | null` so that a legitimately null/undefined
  // value is still distinguishable from "nothing pending".
  let pending: { value: T } | null = null;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    clear();
    if (!pending) return;
    const { value } = pending;
    pending = null;
    write(value);
  };

  return {
    schedule(value: T) {
      pending = { value };
      clear();
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      clear();
      pending = null;
    },
    isPending() {
      return pending !== null;
    },
  };
}
