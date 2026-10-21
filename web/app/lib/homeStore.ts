// The remembered Home body: the last body this browser saw, in
// memory for this page and in sessionStorage for the next one, so a return to
// the tab paints at once and the fetch only refreshes it. An envelope with a
// version: a body of an older shape reads as absent, never as a crash. Storage
// that is blocked or full costs the next page its head start, nothing more.
//
// `.ts` relative import: node --test loads this module (dockState.ts says why).
import type { HomePayload } from "./homePayload.ts";

const KEY = "home_payload_v1";
const VERSION = 2;

let value: HomePayload | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function fromStorage(): HomePayload | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    if (raw === null) return null;
    const env = JSON.parse(raw) as { v?: unknown; body?: unknown } | null;
    if (!env || typeof env !== "object" || env.v !== VERSION) return null;
    const body = env.body as Partial<HomePayload> | null | undefined;
    if (!body || typeof body !== "object" || typeof body.generatedAt !== "string") return null;
    // A body stored before `platforms` existed (the sign-in logos) reads as none — never undefined.
    return { ...body, platforms: Array.isArray(body.platforms) ? body.platforms : [] } as HomePayload;
  } catch {
    return null;
  }
}

/** The remembered body, or null. The same object until the next write. */
export function readHomeStore(): HomePayload | null {
  if (!loaded) {
    value = fromStorage();
    loaded = true;
  }
  return value;
}

export function writeHomeStore(body: HomePayload): void {
  value = body;
  loaded = true;
  const s = storage();
  if (s) {
    try { s.setItem(KEY, JSON.stringify({ v: VERSION, body })); } catch { /* full or blocked: memory still has it */ }
  }
  for (const l of listeners) l();
}

export function subscribeHomeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// @test-only the store is one per page; the tests share one module and reset it between cases.
export function resetHomeStore(): void {
  value = null;
  loaded = false;
}
