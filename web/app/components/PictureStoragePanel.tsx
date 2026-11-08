"use client";
// Settings › Site & bars › Storage on this device: how much the picture cache holds here, and the
// button that empties it (pictureCache.ts). The switches above it are ordinary settings rows.
import { useEffect, useState } from "react";
import { clearPictureCache, formatBytes, pictureCacheBytes } from "@/app/lib/pictureCache";
import { Row } from "./SettingsControls";

const BTN = "h-5 px-2 rounded text-xs bg-surface-2 text-body hover:bg-surface-3 outline-none focus-visible:ring-1 focus-visible:ring-edge-bright disabled:opacity-50";

export default function PictureStoragePanel() {
  const [bytes, setBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    pictureCacheBytes().then((n) => { if (live) setBytes(n); }, () => { if (live) setBytes(0); });
    return () => { live = false; };
  }, []);

  const clear = async () => {
    setBusy(true);
    await clearPictureCache().catch(() => {});
    setBytes(0);
    setBusy(false);
  };

  return (
    <Row label={bytes === null ? "Measuring…" : `Using ${formatBytes(bytes)}`}>
      <button type="button" className={BTN} onClick={() => { void clear(); }} disabled={busy || bytes === 0}>
        Clear cached pictures
      </button>
    </Row>
  );
}
