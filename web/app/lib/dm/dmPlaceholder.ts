// The chat box's words while a DM window holds it: "Message <name>" (Discord's "Message @name"),
// which is also the field's screen-reader name. One line at 390 px: a long name is cut here.
const MAX_LABEL = 24;

export function dmPlaceholder(label: string): string {
  return `Message ${label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label}`;
}
