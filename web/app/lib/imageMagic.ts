// Magic-byte image sniffing for the upload routes (avatar + banner). The
// client-declared Content-Type is attacker-controlled, so both routes validate
// the actual bytes and derive the MIME from them. Extracted from
// api/avatar/upload so the banner route shares one definition — and so the
// logic is testable under node --test (pure, dependency-free on purpose).

const MAGIC: Array<{ bytes: number[]; offset?: number }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47] },             // PNG
  { bytes: [0xff, 0xd8, 0xff] },                     // JPEG
  { bytes: [0x47, 0x49, 0x46, 0x38] },              // GIF
  { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },   // WebP (RIFF....WEBP — check below)
];

export function hasValidImageMagic(buf: Uint8Array): boolean {
  for (const { bytes, offset = 0 } of MAGIC) {
    if (bytes.every((b, i) => buf[offset + i] === b)) {
      if (bytes[0] === 0x52) {
        // WebP: bytes 8-11 must be WEBP
        return [0x57, 0x45, 0x42, 0x50].every((b, i) => buf[8 + i] === b);
      }
      return true;
    }
  }
  return false;
}

/** MIME derived from the magic bytes — never from the client-provided type.
 *  Only meaningful after hasValidImageMagic() returned true. */
export function sniffImageMime(buf: Uint8Array): string {
  return (
    buf[0] === 0x89 ? "image/png" :
    buf[0] === 0xff ? "image/jpeg" :
    buf[0] === 0x47 ? "image/gif" :
    "image/webp"
  );
}
