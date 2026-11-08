"use client";
// The sample under Colours › Mentions & highlights: one mention row and one
// highlight row, drawn with the SAME classes the chat rows use, so it shows
// exactly what the chat will (the chosen colours, and nothing while Behavior ›
// Mentions of me is off). The colours arrive through the CSS variables the two
// settings write, so the sample needs no props and never re-renders for them.
export default function MentionColourPreview() {
  return (
    <div className="mt-1 rounded-md overflow-hidden text-xs text-body" aria-label="Preview">
      <div className="chat-msg-row chat-row-mention px-2 py-1">
        <span className="font-semibold text-strong">Robin</span>{" "}
        <span>@you are you on tonight?</span>
      </div>
      <div className="chat-msg-row chat-row-word px-2 py-1">
        <span className="font-semibold text-strong">Sam</span>{" "}
        <span>who wants tacos?</span>
      </div>
    </div>
  );
}
