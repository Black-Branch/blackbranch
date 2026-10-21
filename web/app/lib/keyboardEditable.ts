// Which focus targets raise the soft keyboard. The keyboard-height hook
// PREDICTS a lift on focusin; predicting for every <input> would mean that
// tapping the colour swatch in chat appearance (an <input type="color">, which
// opens a picker, not a keyboard) shoves the whole page up for nothing.
// Only text-entry inputs type.

const TEXT_INPUT_TYPES = new Set([
  "text", "search", "url", "tel", "email", "password", "number", "",
]);

export function raisesKeyboard(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  // `isContentEditable` is the browser's resolved answer; the attribute is the
  // fallback where that property is not implemented (jsdom).
  if (el.isContentEditable || /^(|true|plaintext-only)$/i.test(el.getAttribute("contenteditable") ?? "false")) return true;
  if (el.tagName !== "INPUT") return false;
  return TEXT_INPUT_TYPES.has(((el as HTMLInputElement).getAttribute("type") ?? "").toLowerCase());
}
