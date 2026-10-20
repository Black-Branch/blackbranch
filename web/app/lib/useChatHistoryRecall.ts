import { useRef, type RefObject } from "react";

// Bash-style input recall: Up at the very start of the box walks back through
// sent messages, Down at the very end walks forward; stepping past the newest
// restores the draft that was in the box before the first Up (unlike Twitch,
// which discards it).
export function useChatHistoryRecall(
  input: string,
  setInput: (v: string) => void,
  inputRef: RefObject<HTMLTextAreaElement | null>
) {
  const chatHistoryRef = useRef<string[]>([]);
  const histIdxRef = useRef(-1); // -1 means "live draft, not browsing"
  const savedDraftRef = useRef("");

  // User edited the box by hand → we're back on a live draft, so the next Up
  // stashes THIS text as the restore point. (Programmatic recalls set `input`
  // via setInput directly, not through this onChange, so they don't reset it.)
  function handleInputChange(v: string) {
    histIdxRef.current = -1;
    setInput(v);
  }

  // Put a recalled history entry (or the restored draft) in the box, caret at end.
  function applyRecalled(text: string) {
    setInput(text);
    const el = inputRef.current;
    if (el) requestAnimationFrame(() => { el.focus(); el.setSelectionRange(text.length, text.length); });
  }

  // Step through recall history. dir=-1 older, dir=+1 newer. Returns true if it
  // handled the key (so the caller suppresses the default caret move).
  function recallHistory(dir: -1 | 1): boolean {
    const hist = chatHistoryRef.current;
    if (hist.length === 0) return false;
    let idx = histIdxRef.current;
    if (dir === -1) {
      if (idx === -1) { savedDraftRef.current = input; idx = hist.length - 1; }
      else if (idx > 0) idx -= 1;
      // else already at the oldest — swallow the key, stay put.
    } else {
      if (idx === -1) return false; // not browsing; let the caret move normally
      if (idx < hist.length - 1) idx += 1;
      else { histIdxRef.current = -1; applyRecalled(savedDraftRef.current); return true; }
    }
    histIdxRef.current = idx;
    applyRecalled(hist[idx] ?? "");
    return true;
  }

  // Record a sent message for recall (skip consecutive duplicates); reset the cursor.
  function recordSent(text: string) {
    const hist = chatHistoryRef.current;
    if (hist[hist.length - 1] !== text) hist.push(text);
    if (hist.length > 50) hist.shift();
    histIdxRef.current = -1;
    savedDraftRef.current = "";
  }

  return { handleInputChange, recallHistory, recordSent };
}
