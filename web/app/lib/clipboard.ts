/** Copy text to the clipboard. Resolves true on success, false when the
 * Clipboard API is unavailable or permission is denied — callers render their
 * own "Copied" feedback off the result. Replaces the direct
 * navigator.clipboard.writeText calls that were scattered (some awaited, some
 * not, some uncaught) across seven components/hooks. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
