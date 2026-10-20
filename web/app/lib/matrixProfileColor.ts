// The username colour as Matrix carries it — a custom profile field (MSC4133) under
// USERNAME_COLOR (matrixNamespace.ts), read under either namespace, product name first.
// The site's own `site.users.username_color` stays the colour the UI uses; this is the copy
// other Matrix clients would see. Pure, so node --test drives it.
import { USERNAME_COLOR, readFirst } from "./matrixNamespace.ts";

const HEX = /^#[0-9a-fA-F]{6}$/;

function hex(v: unknown): string | undefined {
  return typeof v === "string" && HEX.test(v) ? v : undefined;
}

/** The colour from the per-field profile GETs. `bodyOf(field)` is that GET's JSON body, or null
 *  (404 / any error). The spec's body is keyed by the field name; `{ color }` is a shape an older
 *  writer sent (which the server refuses) — accepted here only so no stored value is ever
 *  missed. */
export function profileFieldColor(bodyOf: (field: string) => Record<string, unknown> | null): string | null {
  return readFirst(USERNAME_COLOR, (field) => {
    const body = bodyOf(field);
    return body ? (hex(body[field]) ?? hex(body.color)) : undefined;
  }) ?? null;
}

/** The colour on a room member event's content, under either namespace, or null. */
export function memberContentColor(content: Record<string, unknown> | undefined): string | null {
  return readFirst(USERNAME_COLOR, (field) => hex(content?.[field])) ?? null;
}
