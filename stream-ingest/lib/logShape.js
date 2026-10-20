// The SHAPE of a platform payload, for a journal line: its id and its top-level keys, never a
// value. A platform event we do not yet map (or whose fields drift) still has to be readable in
// journalctl so the mapping can be written, but its values are the viewer's: a Kick gift names the
// gifter and every giftee, a ban names the banned user. Key names are enough to see where a field
// went; the event id is enough to find the event again on the platform's side.
// stream-api/log-names.test.js fails a raw dump (`JSON.stringify(`, `String(`) in an ingest
// journal line, so this is the one way to describe a payload there.

const ID_SHAPE = /^[\w.:-]{1,64}$/;

/**
 * `id=<id|?> keys=[a,b,c]` for an object (or a JSON string of one); `unparsed, N bytes` for text
 * that is not JSON; a type and a size for anything else. Values never appear.
 * @param {unknown} data a parsed payload or the raw frame text
 * @returns {string}
 */
export function payloadShape(data) {
  let d = data;
  if (typeof data === 'string') {
    try { d = JSON.parse(data); } catch { return `unparsed, ${Buffer.byteLength(data)} bytes`; }
    if (typeof d === 'string') return `string, ${Buffer.byteLength(data)} bytes`;
  }
  if (d === null) return 'null';
  if (Array.isArray(d)) return `array of ${d.length}`;
  if (typeof d !== 'object') return typeof d;
  // An id is printed only when it is id-shaped: a scalar of word characters, at most 64 long.
  const raw = d.id;
  const id = (typeof raw === 'number' && Number.isFinite(raw)) || (typeof raw === 'string' && ID_SHAPE.test(raw)) ? raw : '?';
  return `id=${id} keys=[${Object.keys(d).join(',')}]`;
}
