// The site's icons from a file the streamer picks on "Your site" (a streamer has no
// server path to type). SERVER ONLY.
//
// The browser draws the picked image into the five PNGs the site serves (siteIcons.ts) — no image
// library on the server. The site cannot place them itself: the host's site-files/ folder is
// mounted READ-ONLY into web (install/compose.yaml). So they go through the host's request folder,
// the one place web may write: the five files into <requests>/site-icons/, then the request
// `site-icons`. The host checks each again, copies them into site-files/ and answers. Only once it
// has answered does the page stage SITE_ICON_SET=/site-files (applied at Finish with the other
// display values) — a folder the host never filled must never become the site's icons.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The files and their exact sizes (the product's own set in public/brand/ has the same).
 *  @test-only exported so setupIcons.test.ts can hold the sizes to public/brand's files (checkIconSet reads it here). */
export const ICON_FILES = {
  "icon.png": 512, "icon-192.png": 192, "icon-512.png": 512, "icon-maskable-512.png": 512, "apple-touch-icon.png": 180,
} as const;
export type IconFile = keyof typeof ICON_FILES;
const MAX_BYTES = 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One file as the browser sent it (a data: URL), decoded and checked: a PNG, the exact size, at
 *  most 1 MB. → the bytes, or what is wrong.
 *  @test-only exported so each refusal is tested on one file (the pages reach it through checkIconSet). */
export function checkIconFile(name: IconFile, dataUrl: unknown): { ok: true; bytes: Buffer } | { ok: false; error: string } {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) return { ok: false, error: `${name}: a PNG image expected` };
  const b64 = dataUrl.slice("data:image/png;base64,".length);
  if (b64.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { ok: false, error: `${name}: larger than 1 MB, or not an image` };
  const bytes = Buffer.from(b64, "base64");
  // The signature, then the IHDR chunk: its length (13), its name, then width and height.
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG) || bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR") {
    return { ok: false, error: `${name}: not a PNG image` };
  }
  const want = ICON_FILES[name];
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  if (w !== want || h !== want) return { ok: false, error: `${name}: ${w}×${h}, expected ${want}×${want}` };
  return { ok: true, bytes };
}

/** All five, or the first problem. */
export function checkIconSet(files: unknown): { ok: true; files: Record<IconFile, Buffer> } | { ok: false; error: string } {
  if (!files || typeof files !== "object" || Array.isArray(files)) return { ok: false, error: "icons: the five images expected" };
  const got = files as Record<string, unknown>;
  const extra = Object.keys(got).find((k) => !(k in ICON_FILES));
  if (extra) return { ok: false, error: `icons: ${extra.slice(0, 40)} is not one of the icon files` };
  const out = {} as Record<IconFile, Buffer>;
  for (const name of Object.keys(ICON_FILES) as IconFile[]) {
    const r = checkIconFile(name, got[name]);
    if (!r.ok) return r;
    out[name] = r.bytes;
  }
  return { ok: true, files: out };
}

/** The host's answer to `site-icons` (the standard result shape: {ok, at, message}) read for the
 *  page: not answered since `askedAt` → waiting; refused → the host's reason, from `message`;
 *  done → placed. */
export function iconAnswer(result: { ok: boolean; at: string; message: string } | null, askedAt: string):
  { state: "waiting" } | { state: "refused"; message: string } | { state: "placed" } {
  if (!result || !(Date.parse(result.at) >= Date.parse(askedAt))) return { state: "waiting" };
  if (!result.ok) return { state: "refused", message: result.message || "the server gave no reason" };
  return { state: "placed" };
}

/** Once the host placed the files: the display value staged for Finish, like every other .env
 *  value the setup pages set (setup.state.install → the host's apply-install). The host never sets it. */
export function stageIconSet(install: Record<string, string> | undefined): Record<string, string> {
  return { ...(install ?? {}), SITE_ICON_SET: "/site-files" };
}

/** The host's request folder (hostRequests.ts reads the same variable).
 *  @test-only exported so setupIcons.test.ts can hold it to hostRequests.ts (writeIconSet uses it here). */
export function requestsDir(env: Record<string, string | undefined> = process.env): string {
  return env.BB_REQUESTS_DIR || "/requests";
}

/** Put the checked files where the host's `site-icons` request reads them: a fresh folder, so a
 *  file from an earlier upload is never mixed in. */
export async function writeIconSet(files: Record<IconFile, Buffer>, dir = requestsDir()): Promise<void> {
  const into = join(dir, "site-icons");
  await rm(into, { recursive: true, force: true });
  await mkdir(into, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(into, name), bytes);
}
