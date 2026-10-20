"use client";

import { rowBasisCalc } from "@/app/lib/chatFont";
import { useState } from "react";
import { avatarBg } from "@/app/lib/avatarColor";
import { mxcToHttp } from "@/app/lib/matrixMedia";

// The Matrix avatar-with-fallback-initial. Scales with the chat font + pfp-size
// settings, so Matrix avatars stay in lockstep with the live chat panel. The other avatar
// renderings in the app (UserCard's fixed-px ring, UserMenu's em-basis with
// its status dot, chat rows' hot-path column) size and decorate differently
// on purpose — they share `avatarBg` but not this markup.
export function Avatar({
  mxcUrl,
  name,
  size = 28,
}: {
  mxcUrl?: string | null;
  name: string;
  size?: number;
}) {
  const [errored, setErrored] = useState(false);
  const httpUrl = mxcToHttp(mxcUrl, size * 2);
  const initials = name.slice(0, 1).toUpperCase();
  // `size` is the px size at the default 14px chat font; scaled off the frozen
  // row basis (NOT --chat-font-size — avatars do not ride Text Size) and honors
  // the chat pfp-size setting, keeping Matrix avatars in lockstep with the live
  // chat panel's avatars.
  const dim = rowBasisCalc(`${(size / 14).toFixed(3)} * var(--chat-pfp-scale, 1)`);

  if (httpUrl && !errored) {
    return (
      <img
        src={httpUrl}
        alt={name}
        onError={() => setErrored(true)}
        className="rounded-full shrink-0 object-cover img-shadow-chat"
        style={{ width: dim, height: dim }}
      />
    );
  }
  return (
    <div
      className="rounded-full shrink-0 flex items-center justify-center text-strong font-semibold select-none img-shadow-chat"
      style={{
        width: dim,
        height: dim,
        fontSize: rowBasisCalc(((size * 0.44) / 14).toFixed(3)),
        backgroundColor: avatarBg(name),
      }}
    >
      {initials}
    </div>
  );
}
